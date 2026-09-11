// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createTestDatabase,
  jobs,
  jobSources,
  newId,
  workItems,
  type TestDatabase,
} from "../../../src/db";
import {
  IntakeError,
  ScrapePayloadV1,
  MAX_INTAKE_LINES,
  scrapeIdempotencyKey,
  submitIntakeBatch,
} from "../../../src/server";
import type { DnsResolver } from "../../../src/scraping";

const PUBLIC_IP = "93.184.216.34";

/** Deterministic resolver: example hosts are public unless noted. */
function makeResolver(extra: Record<string, string[] | Error> = {}): DnsResolver {
  return async (hostname: string) => {
    if (hostname in extra) {
      const answer = extra[hostname];
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    }
    if (hostname.endsWith(".example") || hostname === "example.com") {
      return [PUBLIC_IP];
    }
    const error = new Error("ENOTFOUND") as Error & { code: string };
    error.code = "ENOTFOUND";
    throw error;
  };
}

function count(t: TestDatabase, table: string): number {
  const row = t.handle.sqlite
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .get() as { n: number };
  return row.n;
}

describe("intake service", () => {
  it("classifies a mixed batch line by line", async () => {
    const t = createTestDatabase();
    try {
      const result = await submitIntakeBatch({
        handle: t.handle,
        resolveHost: makeResolver({ "private.example": ["10.9.9.9"] }),
        lines: [
          "https://example.com/jobs/1?utm_source=x",
          "",
          "https://example.com/jobs/1?utm_source=y&utm_medium=z",
          "not a url",
          "ftp://example.com/jobs/2",
          "http://private.example/secret",
          "   ",
          "https://jobs.example/jobs/9#apply",
        ],
      });
      expect(result.results.map((r) => r.lineNumber)).toEqual([1, 3, 4, 5, 6, 8]);
      expect(result.results.map((r) => r.outcome)).toEqual([
        "ENQUEUED",
        "DUPLICATE",
        "INVALID",
        "INVALID",
        "BLOCKED",
        "ENQUEUED",
      ]);
      expect(result.counts).toEqual({
        rawLineCount: 8,
        enqueuedCount: 2,
        duplicateCount: 1,
        invalidCount: 2,
        blockedCount: 1,
      });
      const [first, dup, , , blocked] = result.results;
      // Original tracking URL preserved; canonical key dedupes.
      expect(first.rawInput).toBe("https://example.com/jobs/1?utm_source=x");
      expect(first.canonicalUrl).toBe("https://example.com/jobs/1");
      expect(dup.duplicateOfLine).toBe(1);
      expect(dup.reasonCode).toBe("DUPLICATE_URL");
      expect(blocked.reasonCode).toBe("PRIVATE_NETWORK");
      expect(first.workItemId).not.toBeNull();
      expect(dup.workItemId).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it("dedupes resubmissions without new work items", async () => {
    const t = createTestDatabase();
    try {
      const lines = ["https://example.com/jobs/1"];
      const first = await submitIntakeBatch({
        handle: t.handle,
        resolveHost: makeResolver(),
        lines,
      });
      expect(first.results[0].outcome).toBe("ENQUEUED");
      const second = await submitIntakeBatch({
        handle: t.handle,
        resolveHost: makeResolver(),
        lines,
      });
      expect(second.results[0].outcome).toBe("DUPLICATE");
      expect(second.results[0].workItemId).toBe(first.results[0].workItemId);
      const items = t.handle.sqlite
        .prepare("SELECT COUNT(*) AS n FROM work_items")
        .get() as { n: number };
      expect(items.n).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  it("links duplicates to already-tracked jobs", async () => {
    const t = createTestDatabase();
    try {
      const jobId = newId();
      t.handle.db.insert(jobs).values({ id: jobId }).run();
      t.handle.db
        .insert(jobSources)
        .values({
          id: newId(),
          jobId,
          submittedUrl: "https://example.com/jobs/1",
          canonicalUrl: "https://example.com/jobs/1",
          canonicalKey: "url:https://example.com/jobs/1",
        })
        .run();
      const result = await submitIntakeBatch({
        handle: t.handle,
        resolveHost: makeResolver(),
        lines: ["https://example.com/jobs/1?utm_x=1"],
      });
      expect(result.results[0].outcome).toBe("DUPLICATE");
      expect(result.results[0].jobId).toBe(jobId);
      expect(count(t, "work_items")).toBe(0);
    } finally {
      t.cleanup();
    }
  });

  it("persists schema-validated scrape payloads", async () => {
    const t = createTestDatabase();
    try {
      await submitIntakeBatch({
        handle: t.handle,
        resolveHost: makeResolver(),
        lines: ["https://example.com/jobs/7?b=2&a=1"],
      });
      const rows = t.handle.db.select().from(workItems).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe("SCRAPE");
      expect(rows[0].state).toBe("QUEUED");
      expect(rows[0].idempotencyKey).toBe(
        scrapeIdempotencyKey("url:https://example.com/jobs/7?a=1&b=2"),
      );
      const payload = ScrapePayloadV1.safeParse(
        JSON.parse(rows[0].payloadJson ?? ""),
      );
      expect(payload.success).toBe(true);
      if (payload.success) {
        expect(payload.data.submittedUrl).toBe(
          "https://example.com/jobs/7?b=2&a=1",
        );
        expect(payload.data.canonicalUrl).toBe(
          "https://example.com/jobs/7?a=1&b=2",
        );
      }
    } finally {
      t.cleanup();
    }
  });

  it("rejects oversized batches before writing anything", async () => {
    const t = createTestDatabase();
    try {
      const lines = Array.from(
        { length: MAX_INTAKE_LINES + 1 },
        (_, i) => `https://example.com/jobs/${i}`,
      );
      let caught: unknown = null;
      try {
        await submitIntakeBatch({
          handle: t.handle,
          resolveHost: makeResolver(),
          lines,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(IntakeError);
      expect((caught as IntakeError).code).toBe("batch-too-large");
      expect(count(t, "intake_batches")).toBe(0);
      expect(count(t, "intake_items")).toBe(0);
    } finally {
      t.cleanup();
    }
  });

  it("maps DNS failures to invalid or retryable outcomes", async () => {
    const t = createTestDatabase();
    try {
      const nx = new Error("nx") as Error & { code: string };
      nx.code = "ENOTFOUND";
      const again = new Error("again") as Error & { code: string };
      again.code = "EAI_AGAIN";
      const result = await submitIntakeBatch({
        handle: t.handle,
        resolveHost: makeResolver({
          "missing.example": nx,
          "flaky.example": again,
        }),
        // Unknown hosts fall through to ENOTFOUND in makeResolver.
        lines: ["https://missing.example/j", "https://flaky.example/j"],
      });
      expect(result.results.map((r) => [r.outcome, r.reasonCode])).toEqual([
        ["INVALID", "INVALID_URL"],
        ["BLOCKED", "TIMEOUT"],
      ]);
    } finally {
      t.cleanup();
    }
  });

  it("dedupes tracking variants and ATS ids across submissions", async () => {
    const t = createTestDatabase();
    try {
      const resolveHost = makeResolver({
        "ca.indeed.com": [PUBLIC_IP],
        "www.indeed.com": [PUBLIC_IP],
      });
      const first = await submitIntakeBatch({
        handle: t.handle,
        resolveHost,
        lines: ["https://ca.indeed.com/viewjob?jk=XYZ&utm_source=a"],
      });
      expect(first.results[0].outcome).toBe("ENQUEUED");
      const second = await submitIntakeBatch({
        handle: t.handle,
        resolveHost,
        lines: ["https://www.indeed.com/other?jk=XYZ&x=1"],
      });
      expect(second.results[0].outcome).toBe("DUPLICATE");
      expect(second.results[0].reasonCode).toBe("DUPLICATE_URL");
    } finally {
      t.cleanup();
    }
  });
});
