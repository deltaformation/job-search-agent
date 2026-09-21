// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createTestDatabase,
  jobs,
  workItems,
  type TestDatabase,
} from "../../../src/db";
import {
  ensureFetchShell,
  persistFetchOutcome,
} from "../../../src/scraping/evidence";
import {
  SCRAPE_PAYLOAD_VERSION,
  type ScrapePayloadV1,
} from "../../../src/server/intake";

/**
 * WO-1.2-D acceptance for D1 (R-ADR-015): clipping stores the JD and
 * rests the job in READY; it enqueues no resume generation. Generation
 * starts only through an explicit user command.
 */

const T0 = "2026-09-14T12:00:00.000Z";

function payloadFor(n: number): ScrapePayloadV1 {
  return {
    schemaVersion: SCRAPE_PAYLOAD_VERSION,
    submittedUrl: `https://example.com/jobs/v12-${n}`,
    canonicalUrl: `https://example.com/jobs/v12-${n}`,
    canonicalKey: `url:https://example.com/jobs/v12-${n}`,
  };
}

function withIsolation(fn: (t: TestDatabase, evidenceDir: string) => void): void {
  const t = createTestDatabase("job-tracker-v12-explicit-");
  const evidenceDir = mkdtempSync(join(tmpdir(), "job-tracker-v12-explicit-"));
  try {
    fn(t, evidenceDir);
  } finally {
    t.cleanup();
    rmSync(evidenceDir, { recursive: true, force: true });
  }
}

/** Clip one JD (one fetch shell); shared by guard + pins. */
function clipPmJob(t: TestDatabase, n: number): { jobId: string } {
  const payload = payloadFor(n);
  const shell = ensureFetchShell(t.handle, { payload, now: T0 });
  if (!shell.ok) {
    throw new Error("clip setup failed: fetch shell not created");
  }
  return { jobId: shell.jobId };
}

function persistExtraction(
  t: TestDatabase,
  evidenceDir: string,
  n: number,
  jobId: string,
  outcome: "SUCCEEDED" | "FAILED",
): string | null {
  const payload = payloadFor(n);
  const result = persistFetchOutcome(t.handle, {
    payload,
    jobId,
    intakeItemId: null,
    workerId: "worker-a",
    startedAt: T0,
    finishedAt: T0,
    finalUrl: payload.canonicalUrl,
    httpStatus: outcome === "SUCCEEDED" ? 200 : 500,
    outcome,
    reasonCode: outcome === "SUCCEEDED" ? null : "TIMEOUT",
    detail: null,
    artifacts: [],
    evidenceDir,
    extraction:
      outcome === "SUCCEEDED"
        ? {
            fields: {
              title: "Product Manager",
              company: "Harbor Analytics",
              location: "Remote",
              arrangement: "REMOTE",
              salaryText: null,
              salaryCurrency: null,
              salaryMinMinor: null,
              salaryMaxMinor: null,
              descriptionText:
                "Own product strategy, roadmap prioritization, and go-to-market launches.",
              postedAt: null,
              applyUrl: null,
            },
            provenance: { title: "v12:title" },
            adapterId: "generic",
            adapterVersion: "1",
            confidence: 0.8,
            missingFields: [],
            contentHash: `${n}`.padEnd(64, "0"),
          }
        : null,
    now: T0,
  });
  return result.extractionId;
}

function tailorItemsFor(t: TestDatabase, jobId: string) {
  return t.handle.db
    .select()
    .from(workItems)
    .where(eq(workItems.jobId, jobId))
    .all();
}

describe("explicit generation (R-ADR-015)", () => {
  it("guard: clipping persists the extraction and keeps the job New", () => {
    withIsolation((t, evidenceDir) => {
      const { jobId } = clipPmJob(t, 1);
      const extractionId = persistExtraction(t, evidenceDir, 1, jobId, "SUCCEEDED");
      expect(extractionId).toBeTruthy();
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      expect(job).toMatchObject({
        status: "NEW",
        tailoringState: "READY",
        activeExtractionId: extractionId,
      });
    });
  });

  it("clipping a JD queues no tailoring work before explicit Start (D1)", () => {
    withIsolation((t, evidenceDir) => {
      const { jobId } = clipPmJob(t, 2);
      const extractionId = persistExtraction(t, evidenceDir, 2, jobId, "SUCCEEDED");
      if (extractionId === null) {
        throw new Error("clip setup failed: extraction not persisted");
      }
      expect(tailorItemsFor(t, jobId)).toHaveLength(0);
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      expect(job?.tailoringState).toBe("READY");
    });
  });

  it("a later extraction after a failed scrape still queues nothing by itself (D1)", () => {
    withIsolation((t, evidenceDir) => {
      const { jobId } = clipPmJob(t, 3);
      const failed = persistExtraction(t, evidenceDir, 3, jobId, "FAILED");
      expect(failed).toBeNull();
      expect(tailorItemsFor(t, jobId)).toHaveLength(0);
      // Re-clip the same URL: the failed shell reopens and the second
      // attempt extracts. Still no tailoring without an explicit Start.
      const reshell = ensureFetchShell(t.handle, { payload: payloadFor(3), now: T0 });
      if (!reshell.ok) {
        throw new Error("re-clip setup failed: fetch shell not reopened");
      }
      const extractionId = persistExtraction(t, evidenceDir, 3, jobId, "SUCCEEDED");
      if (extractionId === null) {
        throw new Error("re-clip setup failed: extraction not persisted");
      }
      expect(tailorItemsFor(t, jobId)).toHaveLength(0);
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      expect(job?.tailoringState).toBe("READY");
    });
  });
});
