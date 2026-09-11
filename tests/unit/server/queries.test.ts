// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTestDatabase,
  newId,
  workItems,
  type TestDatabase,
} from "../../../src/db";
import { completeWorkItem } from "../../../src/queue/leases";
import { ensureFetchShell, persistFetchOutcome } from "../../../src/scraping/evidence";
import { canonicalizeUrl } from "../../../src/scraping/urls";
import {
  SCRAPE_PAYLOAD_VERSION,
  submitIntakeBatch,
} from "../../../src/server/intake";
import {
  findWorkForCanonicalUrl,
  getArtifact,
  getBatchView,
  getWorkItemView,
  listBatches,
} from "../../../src/server/queries";

const PUBLIC_IP = "93.184.216.34";
const T0 = "2026-09-11T12:00:00.000Z";

async function withDatabase(
  fn: (t: TestDatabase) => Promise<void>,
): Promise<void> {
  const t = createTestDatabase("job-tracker-queries-test-");
  try {
    await fn(t);
  } finally {
    t.cleanup();
  }
}

const publicResolver = async () => [PUBLIC_IP];

describe("canonical fixpoint", () => {
  it("re-canonicalizes to the same key", () => {
    for (const raw of [
      "https://example.com/jobs/1?utm_source=x",
      "https://boards.greenhouse.io/acme/jobs/123",
      "https://www.indeed.com/viewjob?jk=abc123",
      "https://www.linkedin.com/jobs/view/12345",
    ]) {
      const first = canonicalizeUrl(raw);
      expect(first.ok).toBe(true);
      if (!first.ok) {
        throw new Error("unreachable");
      }
      const second = canonicalizeUrl(first.value.canonicalUrl);
      expect(second.ok).toBe(true);
      if (!second.ok) {
        throw new Error("unreachable");
      }
      expect(second.value.canonicalKey).toBe(first.value.canonicalKey);
    }
  });
});

describe("batch views", () => {
  it("returns null for unknown batches", async () => {
    await withDatabase(async (t) => {
      expect(getBatchView(t.handle, newId())).toBeNull();
      expect(listBatches(t.handle)).toEqual([]);
    });
  });

  it("lists batches newest first with a bounded limit", async () => {
    await withDatabase(async (t) => {
      const first = await submitIntakeBatch({
        handle: t.handle,
        lines: ["not a url"],
        resolveHost: publicResolver,
      });
      const second = await submitIntakeBatch({
        handle: t.handle,
        lines: ["also not a url"],
        resolveHost: publicResolver,
      });
      const batches = listBatches(t.handle);
      expect(batches.map((b) => b.id)).toEqual([second.batchId, first.batchId]);
      expect(listBatches(t.handle, 1)).toHaveLength(1);
      expect(listBatches(t.handle, 0)).toHaveLength(1);
      expect(listBatches(t.handle, 1000).length).toBeLessThanOrEqual(100);
    });
  });

  it("joins per-line queue state", async () => {
    await withDatabase(async (t) => {
      const submitted = await submitIntakeBatch({
        handle: t.handle,
        lines: ["https://example.com/jobs/1", "not a url"],
        resolveHost: publicResolver,
      });
      const view = getBatchView(t.handle, submitted.batchId);
      expect(view).toMatchObject({
        id: submitted.batchId,
        enqueuedCount: 1,
        invalidCount: 1,
      });
      expect(view?.items).toHaveLength(2);
      expect(view?.items[0]).toMatchObject({
        lineNumber: 1,
        outcome: "ENQUEUED",
      });
      expect(view?.items[0].queue).toMatchObject({ workState: "QUEUED" });
      expect(view?.items[1]).toMatchObject({
        lineNumber: 2,
        outcome: "INVALID",
        queue: null,
      });
      expect(
        findWorkForCanonicalUrl(t.handle, null),
      ).toBeNull();
      expect(
        findWorkForCanonicalUrl(t.handle, "https://example.com/never-queued"),
      ).toBeNull();
    });
  });
});

describe("work item views", () => {
  it("returns null for unknown items", async () => {
    await withDatabase(async (t) => {
      expect(getWorkItemView(t.handle, newId())).toBeNull();
      expect(getArtifact(t.handle, newId())).toBeNull();
    });
  });

  it("shows attempts, job, extraction, and artifacts", async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "job-tracker-query-ev-"));
    await withDatabase(async (t) => {
      const submitted = await submitIntakeBatch({
        handle: t.handle,
        lines: ["https://example.com/jobs/9"],
        resolveHost: publicResolver,
      });
      const workItemId = submitted.results[0].workItemId;
      expect(workItemId).toBeTruthy();
      if (workItemId === null) {
        throw new Error("unreachable");
      }
      // Simulate one failed worker attempt, then a fetched shell.
      const claimed = t.handle.db
        .select()
        .from(workItems)
        .all()
        .find((row) => row.id === workItemId);
      expect(claimed?.leaseToken).toBeNull();
      const payload = {
        schemaVersion: SCRAPE_PAYLOAD_VERSION,
        submittedUrl: "https://example.com/jobs/9",
        canonicalUrl: "https://example.com/jobs/9",
        canonicalKey: "url:https://example.com/jobs/9",
      } as const;
      const shell = ensureFetchShell(t.handle, { payload, now: T0 });
      if (!shell.ok) {
        throw new Error("unreachable");
      }
      const html = Buffer.from("<html><body>job</body></html>", "utf8");
      const persisted = persistFetchOutcome(t.handle, {
        payload,
        jobId: shell.jobId,
        intakeItemId: submitted.results[0].intakeItemId,
        workerId: "worker-a",
        startedAt: T0,
        finishedAt: T0,
        finalUrl: payload.canonicalUrl,
        httpStatus: 200,
        outcome: "SUCCEEDED",
        reasonCode: null,
        detail: null,
        artifacts: [{ kind: "HTML", bytes: html, mediaType: "text/html" }],
        evidenceDir,
        extraction: {
          fields: {
            title: "Engineer",
            company: null,
            location: "Remote",
            arrangement: "REMOTE",
            salaryText: null,
            salaryCurrency: null,
            salaryMinMinor: null,
            salaryMaxMinor: null,
            descriptionText: "Do things.",
            postedAt: null,
            applyUrl: payload.canonicalUrl,
          },
          provenance: { title: "test" },
          adapterId: "generic",
          adapterVersion: "1",
          confidence: 0.7,
          missingFields: ["company", "salary", "postedAt"],
          contentHash: "a".repeat(64),
        },
        now: T0,
      });
      const view = getWorkItemView(t.handle, workItemId);
      expect(view?.workItem).toMatchObject({ id: workItemId, kind: "SCRAPE" });
      expect(view?.intakeItem).toMatchObject({
        id: submitted.results[0].intakeItemId,
        lineNumber: 1,
      });
      expect(view?.scrapeOutcome).toBe("SUCCEEDED");
      expect(view?.job).toMatchObject({
        id: shell.jobId,
        title: "Engineer",
        arrangement: "REMOTE",
        adapter: "generic",
        confidence: 0.7,
        applyUrl: payload.canonicalUrl,
      });
      expect(view?.job?.missingFields).toContain("salary");
      expect(view?.artifacts).toHaveLength(1);
      expect(view?.artifacts[0]).toMatchObject({ kind: "HTML" });
      const artifact = getArtifact(t.handle, view?.artifacts[0].id ?? "");
      expect(artifact?.sha256).toBe(view?.artifacts[0].sha256);
      expect(persisted.extractionId).toBeTruthy();
    });
    rmSync(evidenceDir, { recursive: true, force: true });
  });

  it("lists queue attempts oldest first", async () => {
    await withDatabase(async (t) => {
      const id = newId();
      t.handle.db
        .insert(workItems)
        .values({
          id,
          kind: "SCRAPE",
          idempotencyKey: `key-${id}`,
          payloadJson: "{}",
          state: "RUNNING",
          leaseToken: "token",
          leasedAt: T0,
          leaseExpiresAt: T0,
          workerId: "worker-a",
          attemptCount: 1,
          maxAttempts: 3,
        })
        .run();
      const completed = completeWorkItem(
        t.handle,
        { workItemId: id, leaseToken: "token", result: "FAILED", errorCode: "TIMEOUT" },
        { now: T0 },
      );
      expect(completed.ok).toBe(true);
      const view = getWorkItemView(t.handle, id);
      expect(view?.attempts).toHaveLength(1);
      expect(view?.attempts[0]).toMatchObject({
        attemptNumber: 1,
        result: "FAILED",
        errorCode: "TIMEOUT",
      });
      expect(view?.job).toBeNull();
      expect(view?.intakeItem).toBeNull();
    });
  });
});
