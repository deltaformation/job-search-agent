// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createTestDatabase,
  jobExtractions,
  jobSources,
  jobs,
  scrapeAttempts,
  sourceArtifacts,
  workItems,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import {
  ensureFetchShell,
  persistFetchOutcome,
  storeEvidence,
} from "../../../src/scraping/evidence";
import {
  SCRAPE_PAYLOAD_VERSION,
  type ScrapePayloadV1,
} from "../../../src/server/intake";

const T0 = "2026-09-11T12:00:00.000Z";

function payloadFor(n: number): ScrapePayloadV1 {
  return {
    schemaVersion: SCRAPE_PAYLOAD_VERSION,
    submittedUrl: `https://example.com/jobs/${n}?utm_source=x`,
    canonicalUrl: `https://example.com/jobs/${n}`,
    canonicalKey: `url:https://example.com/jobs/${n}`,
  };
}

function withEvidence(
  fn: (t: TestDatabase, evidenceDir: string) => void,
): void {
  const t = createTestDatabase("job-tracker-evidence-test-");
  const evidenceDir = mkdtempSync(join(tmpdir(), "job-tracker-evidence-"));
  try {
    fn(t, evidenceDir);
  } finally {
    t.cleanup();
    rmSync(evidenceDir, { recursive: true, force: true });
  }
}

function getJob(handle: DatabaseHandle, jobId: string) {
  return handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
}

describe("evidence storage", () => {
  it("stores bytes content-addressed and writes once", () => {
    withEvidence((_t, evidenceDir) => {
      const bytes = Buffer.from("<html>hi</html>", "utf8");
      const first = storeEvidence(evidenceDir, "HTML", bytes);
      const expected = createHash("sha256").update(bytes).digest("hex");
      expect(first.sha256).toBe(expected);
      expect(first.relativePath).toBe(`${expected.slice(0, 2)}/${expected}.html`);
      expect(first.byteSize).toBe(bytes.length);
      expect(
        readFileSync(join(evidenceDir, first.relativePath)),
      ).toEqual(bytes);
      // Identical bytes reuse the stored file; kinds get their own suffix.
      expect(storeEvidence(evidenceDir, "HTML", bytes)).toEqual(first);
      expect(storeEvidence(evidenceDir, "TEXT", bytes).relativePath).toMatch(
        /\.txt$/,
      );
      expect(storeEvidence(evidenceDir, "JSONLD", bytes).relativePath).toMatch(
        /\.json$/,
      );
    });
  });
});

describe("fetch shell", () => {
  it("creates a running shell with its source row", () => {
    withEvidence((t) => {
      const payload = payloadFor(1);
      const shell = ensureFetchShell(t.handle, { payload, now: T0 });
      expect(shell).toMatchObject({ ok: true, isNew: true });
      if (!shell.ok) {
        throw new Error("unreachable");
      }
      expect(getJob(t.handle, shell.jobId)).toMatchObject({
        status: "NEW",
        scrapeState: "RUNNING",
      });
      const source = t.handle.db
        .select()
        .from(jobSources)
        .where(eq(jobSources.jobId, shell.jobId))
        .get();
      expect(source).toMatchObject({
        submittedUrl: payload.submittedUrl,
        canonicalUrl: payload.canonicalUrl,
        canonicalKey: payload.canonicalKey,
        finalUrl: null,
      });
    });
  });

  it("re-enters running shells and retries failed or blocked ones", () => {
    withEvidence((t) => {
      for (const [n, state] of [
        [2, "RUNNING"],
        [3, "FAILED"],
        [4, "BLOCKED"],
        [5, "QUEUED"],
      ] as const) {
        const payload = payloadFor(n);
        const first = ensureFetchShell(t.handle, { payload, now: T0 });
        if (!first.ok) {
          throw new Error("unreachable");
        }
        t.handle.db
          .update(jobs)
          .set({ scrapeState: state })
          .where(eq(jobs.id, first.jobId))
          .run();
        const retry = ensureFetchShell(t.handle, { payload, now: T0 });
        expect(retry).toMatchObject({ ok: true, jobId: first.jobId });
        expect(getJob(t.handle, first.jobId)?.scrapeState).toBe("RUNNING");
      }
    });
  });

  it("refuses to re-scrape succeeded shells", () => {
    withEvidence((t) => {
      const payload = payloadFor(6);
      const first = ensureFetchShell(t.handle, { payload, now: T0 });
      if (!first.ok) {
        throw new Error("unreachable");
      }
      t.handle.db
        .update(jobs)
        .set({ scrapeState: "SUCCEEDED" })
        .where(eq(jobs.id, first.jobId))
        .run();
      expect(ensureFetchShell(t.handle, { payload, now: T0 })).toMatchObject({
        ok: false,
        error: "already-succeeded",
      });
    });
  });
});

describe("fetch persistence", () => {
  it("persists success with attempt, artifacts, and final url", () => {
    withEvidence((t, evidenceDir) => {
      const payload = payloadFor(7);
      const shell = ensureFetchShell(t.handle, { payload, now: T0 });
      if (!shell.ok) {
        throw new Error("unreachable");
      }
      const html = Buffer.from("<html><body>job</body></html>", "utf8");
      const text = Buffer.from("job", "utf8");
      const result = persistFetchOutcome(t.handle, {
        payload,
        jobId: shell.jobId,
        intakeItemId: null,
        workerId: "worker-a",
        startedAt: T0,
        finishedAt: "2026-09-11T12:00:05.000Z",
        finalUrl: "https://example.com/jobs/7",
        httpStatus: 200,
        outcome: "SUCCEEDED",
        reasonCode: null,
        detail: null,
        artifacts: [
          { kind: "HTML", bytes: html, mediaType: "text/html" },
          { kind: "TEXT", bytes: text, mediaType: "text/plain" },
        ],
        evidenceDir,
        now: T0,
      });
      expect(result.scrapeState).toBe("SUCCEEDED");
      expect(result.refs).toHaveLength(2);
      expect(getJob(t.handle, shell.jobId)).toMatchObject({
        scrapeState: "SUCCEEDED",
        scrapeReasonCode: null,
      });
      const source = t.handle.db
        .select()
        .from(jobSources)
        .where(eq(jobSources.jobId, shell.jobId))
        .get();
      expect(source?.finalUrl).toBe("https://example.com/jobs/7");
      const attempt = t.handle.db
        .select()
        .from(scrapeAttempts)
        .where(eq(scrapeAttempts.id, result.attemptId))
        .get();
      expect(attempt).toMatchObject({
        jobId: shell.jobId,
        canonicalUrl: payload.canonicalUrl,
        outcome: "SUCCEEDED",
        workerId: "worker-a",
      });
      const rows = t.handle.db
        .select()
        .from(sourceArtifacts)
        .where(eq(sourceArtifacts.scrapeAttemptId, result.attemptId))
        .all();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const stored = readFileSync(join(evidenceDir, row.relativePath));
        expect(stored.length).toBe(row.byteSize);
        expect(createHash("sha256").update(stored).digest("hex")).toBe(
          row.sha256,
        );
      }
    });
  });

  it("persists blocks without artifacts", () => {
    withEvidence((t, evidenceDir) => {
      const payload = payloadFor(8);
      const shell = ensureFetchShell(t.handle, { payload, now: T0 });
      if (!shell.ok) {
        throw new Error("unreachable");
      }
      const result = persistFetchOutcome(t.handle, {
        payload,
        jobId: shell.jobId,
        intakeItemId: null,
        workerId: "worker-a",
        startedAt: T0,
        finishedAt: T0,
        finalUrl: payload.canonicalUrl,
        httpStatus: 403,
        outcome: "BLOCKED",
        reasonCode: "ACCESS_DENIED",
        detail: "server refused the page (HTTP 403)",
        artifacts: [],
        evidenceDir,
        now: T0,
      });
      expect(result.refs).toEqual([]);
      expect(getJob(t.handle, shell.jobId)).toMatchObject({
        scrapeState: "BLOCKED",
        scrapeReasonCode: "ACCESS_DENIED",
      });
      const rows = t.handle.db
        .select()
        .from(sourceArtifacts)
        .where(eq(sourceArtifacts.scrapeAttemptId, result.attemptId))
        .all();
      expect(rows).toEqual([]);
    });
  });

  it("persists extracted fields with the extraction row", () => {
    withEvidence((t, evidenceDir) => {
      const payload = payloadFor(10);
      const shell = ensureFetchShell(t.handle, { payload, now: T0 });
      if (!shell.ok) {
        throw new Error("unreachable");
      }
      const result = persistFetchOutcome(t.handle, {
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
        artifacts: [
          {
            kind: "HTML",
            bytes: Buffer.from("<html></html>", "utf8"),
            mediaType: "text/html",
          },
        ],
        evidenceDir,
        extraction: {
          fields: {
            title: "Senior Engineer",
            company: "Acme",
            location: "Remote",
            arrangement: "REMOTE",
            salaryText: "$150,000 per year",
            salaryCurrency: "USD",
            salaryMinMinor: 15_000_000,
            salaryMaxMinor: 15_000_000,
            descriptionText: "Build things.",
            postedAt: "2026-08-20",
            applyUrl: "https://example.com/jobs/10/apply",
          },
          provenance: { title: "test:title" },
          adapterId: "generic",
          adapterVersion: "1",
          confidence: 0.7,
          missingFields: [],
          contentHash: "f".repeat(64),
        },
        now: T0,
      });
      expect(result.extractionId).toBeTruthy();
      expect(getJob(t.handle, shell.jobId)).toMatchObject({
        title: "Senior Engineer",
        company: "Acme",
        location: "Remote",
        arrangement: "REMOTE",
        salaryCurrency: "USD",
        salaryMinMinor: 15_000_000,
        salaryMaxMinor: 15_000_000,
        descriptionText: "Build things.",
        postedAt: "2026-08-20",
        activeExtractionId: result.extractionId,
      });
      const extraction = t.handle.db
        .select()
        .from(jobExtractions)
        .where(eq(jobExtractions.id, result.extractionId ?? ""))
        .get();
      expect(extraction).toMatchObject({
        jobId: shell.jobId,
        scrapeAttemptId: result.attemptId,
        version: 1,
        schemaVersion: "job-extraction-v1",
        adapter: "generic",
        adapterVersion: "1",
        confidence: 0.7,
      });
      const record = JSON.parse(extraction?.extractedJson ?? "{}") as {
        schemaVersion: string;
        contentHash: string;
      };
      expect(record.schemaVersion).toBe("job-extraction-v1");
      expect(record.contentHash).toBe("f".repeat(64));
      const source = t.handle.db
        .select()
        .from(jobSources)
        .where(eq(jobSources.jobId, shell.jobId))
        .get();
      expect(source?.applyUrl).toBe("https://example.com/jobs/10/apply");
    });
  });

  it("queues no tailoring on extraction and rests the job in READY (D1)", () => {
    withEvidence((t, evidenceDir) => {
      const payload = payloadFor(13);
      const shell = ensureFetchShell(t.handle, { payload, now: T0 });
      if (!shell.ok) {
        throw new Error("unreachable");
      }
      const result = persistFetchOutcome(t.handle, {
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
        extraction: {
          fields: {
            title: "Engineer",
            company: "Acme",
            location: "Remote",
            arrangement: "REMOTE",
            salaryText: null,
            salaryCurrency: null,
            salaryMinMinor: null,
            salaryMaxMinor: null,
            descriptionText: "Build things.",
            postedAt: null,
            applyUrl: null,
          },
          provenance: {},
          adapterId: "generic",
          adapterVersion: "1",
          confidence: 0.7,
          missingFields: [],
          contentHash: "e".repeat(64),
        },
        now: T0,
      });
      expect(result.extractionId).toBeTruthy();
      // D1: extraction persists evidence only. Generation starts through
      // an explicit user command; the job rests READY until then.
      const items = t.handle.db
        .select()
        .from(workItems)
        .where(eq(workItems.kind, "TAILOR"))
        .all();
      expect(items).toHaveLength(0);
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, shell.jobId)).get();
      expect(job).toMatchObject({ tailoringState: "READY", activeExtractionId: result.extractionId });
    });
  });

  it("requests no tailoring without a new extraction", () => {
    withEvidence((t, evidenceDir) => {
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
        httpStatus: 403,
        outcome: "BLOCKED",
        reasonCode: "ACCESS_DENIED",
        detail: "server refused the page (HTTP 403)",
        artifacts: [],
        evidenceDir,
        now: T0,
      });
      const items = t.handle.db
        .select()
        .from(workItems)
        .where(eq(workItems.kind, "TAILOR"))
        .all();
      expect(items).toEqual([]);
    });
  });

  it("refuses extraction rows on failed outcomes", () => {
    withEvidence((t, evidenceDir) => {
      const payload = payloadFor(11);
      const shell = ensureFetchShell(t.handle, { payload, now: T0 });
      if (!shell.ok) {
        throw new Error("unreachable");
      }
      expect(() =>
        persistFetchOutcome(t.handle, {
          payload,
          jobId: shell.jobId,
          intakeItemId: null,
          workerId: "worker-a",
          startedAt: T0,
          finishedAt: T0,
          finalUrl: payload.canonicalUrl,
          httpStatus: null,
          outcome: "FAILED",
          reasonCode: "TIMEOUT",
          detail: "navigation failed",
          artifacts: [],
          evidenceDir,
          extraction: {
            fields: {
              title: null,
              company: null,
              location: null,
              arrangement: "UNKNOWN",
              salaryText: null,
              salaryCurrency: null,
              salaryMinMinor: null,
              salaryMaxMinor: null,
              descriptionText: null,
              postedAt: null,
              applyUrl: payload.canonicalUrl,
            },
            provenance: {},
            adapterId: "generic",
            adapterVersion: "1",
            confidence: 0.6,
            missingFields: ["title"],
            contentHash: "f".repeat(64),
          },
          now: T0,
        }),
      ).toThrow(/SUCCEEDED/);
    });
  });

  it("requires a reason for failures and refuses double persist", () => {
    withEvidence((t, evidenceDir) => {
      const payload = payloadFor(9);
      const shell = ensureFetchShell(t.handle, { payload, now: T0 });
      if (!shell.ok) {
        throw new Error("unreachable");
      }
      const base = {
        payload,
        jobId: shell.jobId,
        intakeItemId: null,
        workerId: "worker-a",
        startedAt: T0,
        finishedAt: T0,
        finalUrl: payload.canonicalUrl,
        httpStatus: null as number | null,
        outcome: "FAILED" as const,
        detail: "navigation failed",
        artifacts: [],
        evidenceDir,
        now: T0,
      };
      expect(() =>
        persistFetchOutcome(t.handle, { ...base, reasonCode: null }),
      ).toThrow(/reason/);
      persistFetchOutcome(t.handle, { ...base, reasonCode: "TIMEOUT" });
      expect(() =>
        persistFetchOutcome(t.handle, { ...base, reasonCode: "TIMEOUT" }),
      ).toThrow(/no longer RUNNING/);
      const attempts = t.handle.db
        .select()
        .from(scrapeAttempts)
        .where(eq(scrapeAttempts.jobId, shell.jobId))
        .all();
      expect(attempts).toHaveLength(1);
    });
  });
});
