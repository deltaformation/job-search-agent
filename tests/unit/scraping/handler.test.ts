// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createTestDatabase,
  jobExtractions,
  jobs,
  jobSources,
  newId,
  scrapeAttempts,
  sourceArtifacts,
  workItems,
  type TestDatabase,
} from "../../../src/db";
import { claimNextWorkItem } from "../../../src/queue/leases";
import type { WorkHandlerContext } from "../../../src/queue/dispatch";
import { ensureFetchShell, persistFetchOutcome } from "../../../src/scraping/evidence";
import type { PageFetch } from "../../../src/scraping/fetch";
import { createScrapeHandler } from "../../../src/scraping/handler";
import {
  SCRAPE_PAYLOAD_VERSION,
  type ScrapePayloadV1,
} from "../../../src/server/intake";

const T0 = "2026-09-11T12:00:00.000Z";

function payloadFor(n: number): ScrapePayloadV1 {
  return {
    schemaVersion: SCRAPE_PAYLOAD_VERSION,
    submittedUrl: `https://example.com/jobs/${n}`,
    canonicalUrl: `https://example.com/jobs/${n}`,
    canonicalKey: `url:https://example.com/jobs/${n}`,
  };
}

function successFetch(): PageFetch {
  const html = [
    "<html><head><title>Senior Engineer - Acme</title>",
    '<meta name="description" content="Build things at Acme with a senior team.">',
    "</head><body><h1>Senior Engineer</h1>",
    "<p>Build things at Acme with a senior team.</p>",
    '<a href="https://example.com/jobs/11/apply">Apply</a>',
    "</body></html>",
  ].join("");
  return {
    finalUrl: "https://example.com/jobs/11",
    httpStatus: 200,
    redirectChain: [],
    outcome: "SUCCEEDED",
    reasonCode: null,
    detail: null,
    title: "Senior Engineer - Acme",
    html: Buffer.from(html, "utf8"),
    htmlMediaType: "text/html; charset=utf-8",
    text: "Senior Engineer\nBuild things at Acme with a senior team.",
    jsonLdBlocks: [],
  };
}

function withHandler(
  fn: (t: TestDatabase, evidenceDir: string) => Promise<void>,
): Promise<void> {
  const t = createTestDatabase("job-tracker-handler-test-");
  const evidenceDir = mkdtempSync(join(tmpdir(), "job-tracker-handler-"));
  return fn(t, evidenceDir).finally(() => {
    t.cleanup();
    rmSync(evidenceDir, { recursive: true, force: true });
  });
}

function enqueueClaim(
  t: TestDatabase,
  payloadJson: string | null,
): WorkHandlerContext {
  const id = newId();
  t.handle.db
    .insert(workItems)
    .values({
      id,
      kind: "SCRAPE",
      idempotencyKey: `key-${id}`,
      payloadJson,
    })
    .run();
  const claimed = claimNextWorkItem(t.handle, {
    workerId: "worker-a",
    leaseDurationMs: 60_000,
    now: T0,
  });
  if (claimed === null) {
    throw new Error("setup claim failed");
  }
  return {
    handle: t.handle,
    item: claimed,
    workerId: "worker-a",
    heartbeat: () => true,
  };
}

describe("scrape handler", () => {
  it("fetches, persists, and hashes a successful page", async () => {
    await withHandler(async (t, evidenceDir) => {
      const context = enqueueClaim(t, JSON.stringify(payloadFor(11)));
      let calls = 0;
      const handler = createScrapeHandler({
        evidenceDir,
        fetchPage: async () => {
          calls += 1;
          return successFetch();
        },
        clock: () => T0,
      });
      const outcome = await handler(context);
      expect(calls).toBe(1);
      expect(outcome.result).toBe("SUCCEEDED");
      expect(outcome.inputHash).toMatch(/^[0-9a-f]{64}$/);
      expect(outcome.outputHash).toMatch(/^[0-9a-f]{64}$/);
      const job = t.handle.db.select().from(jobs).all();
      expect(job).toHaveLength(1);
      expect(job[0]).toMatchObject({
        scrapeState: "SUCCEEDED",
        title: "Senior Engineer - Acme",
        company: null,
        arrangement: "UNKNOWN",
      });
      expect(job[0].descriptionText).toContain("Build things at Acme");
      expect(job[0].activeExtractionId).toBeTruthy();
      const attempts = t.handle.db
        .select()
        .from(scrapeAttempts)
        .where(eq(scrapeAttempts.jobId, job[0].id))
        .all();
      expect(attempts).toHaveLength(1);
      expect(attempts[0].outcome).toBe("SUCCEEDED");
      const artifacts = t.handle.db
        .select()
        .from(sourceArtifacts)
        .where(eq(sourceArtifacts.scrapeAttemptId, attempts[0].id))
        .all();
      expect(artifacts.map((row) => row.kind).sort()).toEqual([
        "HTML",
        "TEXT",
      ]);
      const extractions = t.handle.db
        .select()
        .from(jobExtractions)
        .where(eq(jobExtractions.jobId, job[0].id))
        .all();
      expect(extractions).toHaveLength(1);
      expect(extractions[0]).toMatchObject({
        id: job[0].activeExtractionId,
        scrapeAttemptId: attempts[0].id,
        version: 1,
        schemaVersion: "job-extraction-v1",
        adapter: "generic",
        adapterVersion: "1",
      });
      expect(extractions[0].confidence).toBeGreaterThan(0.5);
      expect(JSON.parse(extractions[0].missingFieldsJson ?? "[]")).toContain(
        "company",
      );
      const source = t.handle.db
        .select()
        .from(jobSources)
        .where(eq(jobSources.jobId, job[0].id))
        .get();
      expect(source?.applyUrl).toBe("https://example.com/jobs/11/apply");
    });
  });

  it("fails thin fetches as incomplete while keeping their artifacts", async () => {
    await withHandler(async (t, evidenceDir) => {
      const context = enqueueClaim(t, JSON.stringify(payloadFor(15)));
      const outcome = await createScrapeHandler({
        evidenceDir,
        fetchPage: async () => ({
          ...successFetch(),
          html: Buffer.from("<html><body></body></html>", "utf8"),
          text: "",
          jsonLdBlocks: [],
        }),
        clock: () => T0,
      })(context);
      expect(outcome).toMatchObject({
        result: "FAILED",
        errorCode: "EXTRACTION_INCOMPLETE",
      });
      const job = t.handle.db.select().from(jobs).all();
      expect(job).toHaveLength(1);
      expect(job[0]).toMatchObject({
        scrapeState: "FAILED",
        scrapeReasonCode: "EXTRACTION_INCOMPLETE",
        title: null,
        activeExtractionId: null,
      });
      expect(
        t.handle.db.select().from(jobExtractions).all(),
      ).toHaveLength(0);
      // Real fetched bytes are kept as evidence for a future retry.
      expect(
        t.handle.db.select().from(sourceArtifacts).all().length,
      ).toBeGreaterThan(0);
    });
  });

  it("passes blocked and failed fetches through with reasons", async () => {
    await withHandler(async (t, evidenceDir) => {
      const blocked = enqueueClaim(t, JSON.stringify(payloadFor(12)));
      const blockedOutcome = await createScrapeHandler({
        evidenceDir,
        fetchPage: async () => ({
          ...successFetch(),
          outcome: "BLOCKED" as const,
          reasonCode: "LOGIN_REQUIRED" as const,
          detail: "page requires signing in",
          html: null,
          htmlMediaType: null,
          text: null,
          jsonLdBlocks: [],
        }),
        clock: () => T0,
      })(blocked);
      expect(blockedOutcome).toMatchObject({
        result: "BLOCKED",
        errorCode: "LOGIN_REQUIRED",
      });
      const failed = enqueueClaim(t, JSON.stringify(payloadFor(13)));
      const failedOutcome = await createScrapeHandler({
        evidenceDir,
        fetchPage: async () => ({
          ...successFetch(),
          outcome: "FAILED" as const,
          reasonCode: "TIMEOUT" as const,
          detail: "navigation failed",
          html: null,
          htmlMediaType: null,
          text: null,
          jsonLdBlocks: [],
        }),
        clock: () => T0,
      })(failed);
      expect(failedOutcome).toMatchObject({
        result: "FAILED",
        errorCode: "TIMEOUT",
      });
      // Neither outcome stores artifacts.
      expect(t.handle.db.select().from(sourceArtifacts).all()).toEqual([]);
    });
  });

  it("rejects unusable payloads without fetching", async () => {
    await withHandler(async (t, evidenceDir) => {
      let calls = 0;
      const handler = createScrapeHandler({
        evidenceDir,
        fetchPage: async () => {
          calls += 1;
          return successFetch();
        },
      });
      for (const payloadJson of [
        "not json",
        null,
        JSON.stringify({ schemaVersion: "scrape-payload-v9" }),
        JSON.stringify({ schemaVersion: SCRAPE_PAYLOAD_VERSION }),
      ]) {
        const context = enqueueClaim(t, payloadJson);
        const outcome = await handler(context);
        expect(outcome).toMatchObject({
          result: "FAILED",
          errorCode: "STALE_INPUT",
        });
      }
      expect(calls).toBe(0);
      expect(t.handle.db.select().from(jobs).all()).toEqual([]);
    });
  });

  it("refuses already-scraped shells without fetching", async () => {
    await withHandler(async (t, evidenceDir) => {
      const payload = payloadFor(14);
      const shell = ensureFetchShell(t.handle, { payload, now: T0 });
      if (!shell.ok) {
        throw new Error("unreachable");
      }
      persistFetchOutcome(t.handle, {
        payload,
        jobId: shell.jobId,
        intakeItemId: null,
        workerId: "worker-a",
        startedAt: T0,
        finishedAt: T0,
        finalUrl: payload.canonicalUrl,
        httpStatus: 200,
        outcome: "SUCCEEDED",
        reasonCode: null,
        detail: null,
        artifacts: [],
        evidenceDir,
        now: T0,
      });
      let calls = 0;
      const outcome = await createScrapeHandler({
        evidenceDir,
        fetchPage: async () => {
          calls += 1;
          return successFetch();
        },
      })(enqueueClaim(t, JSON.stringify(payload)));
      expect(outcome).toMatchObject({
        result: "FAILED",
        errorCode: "STALE_INPUT",
      });
      expect(calls).toBe(0);
    });
  });
});
