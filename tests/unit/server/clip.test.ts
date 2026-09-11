// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../../src/db";
import {
  intakeBatches,
  intakeItems,
  jobExtractions,
  jobs,
  jobSources,
  scrapeAttempts,
  sourceArtifacts,
} from "../../../src/db/schema";
import {
  clipJsonLdBlocks,
  clipTextFromHtml,
  ingestClippedDom,
} from "../../../src/server/clip";

const FIXTURE_HTML = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "extraction",
    "fixtures",
    "jobposting-jsonld.html",
  ),
  "utf8",
);
const CLIP_URL = "https://example.com/jobs/staff-engineer";
const CAPTCHA_HTML =
  '<html><head><title>Verify you are human</title></head><body>' +
  "<p>Please solve this captcha to continue.</p></body></html>";
const THIN_HTML = "<html><head><title></title></head><body><p>hi</p></body></html>";

function withDatabase(
  fn: (t: TestDatabase, evidenceDir: string) => void,
): void {
  const t = createTestDatabase("job-tracker-clip-test-");
  try {
    const evidenceDir = join(t.dir, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    fn(t, evidenceDir);
  } finally {
    t.cleanup();
  }
}

describe("clip text and JSON-LD derivation", () => {
  it("strips scripts and styles from visible text", () => {
    const text = clipTextFromHtml(
      "<html><head><script>var x = 1;</script><style>.a{}</style></head>" +
        "<body><h1>Role</h1><p>Apply now</p></body></html>",
    );
    expect(text).not.toContain("var x");
    expect(text).not.toContain(".a{}");
    expect(text).toContain("Role");
    expect(text).toContain("Apply now");
  });

  it("extracts JSON-LD blocks and skips empties", () => {
    expect(clipJsonLdBlocks(FIXTURE_HTML).length).toBeGreaterThan(0);
    expect(clipJsonLdBlocks("<html><body><p>none</p></body></html>")).toEqual([]);
    expect(
      clipJsonLdBlocks(
        '<script type="application/ld+json">   </script><p>x</p>',
      ),
    ).toEqual([]);
  });
});

describe("ingestClippedDom", () => {
  it("creates a NEW job with evidence and extraction", () => {
    withDatabase((t, evidenceDir) => {
      const result = ingestClippedDom(t.handle, {
        submittedUrl: CLIP_URL,
        html: FIXTURE_HTML,
        title: "Staff Engineer - Gamma LLC",
        source: "clip",
        evidenceDir,
      });
      expect(result.outcome).toBe("created");
      if (result.outcome !== "created") return;
      expect(result.adapter).toBe("jsonld");
      expect(result.missingFields).toEqual([]);

      const job = t.handle.db
        .select()
        .from(jobs)
        .where(eq(jobs.id, result.jobId))
        .get();
      expect(job).toMatchObject({
        status: "NEW",
        title: "Staff Engineer",
        company: "Gamma LLC",
        scrapeState: "SUCCEEDED",
      });
      const extraction = t.handle.db
        .select()
        .from(jobExtractions)
        .where(eq(jobExtractions.id, result.extractionId))
        .get();
      expect(extraction?.jobId).toBe(result.jobId);

      const artifacts = t.handle.db
        .select()
        .from(sourceArtifacts)
        .all()
        .sort((a, b) => a.kind.localeCompare(b.kind));
      expect(artifacts.map((row) => row.kind)).toEqual(["HTML", "JSONLD", "TEXT"]);
      for (const row of artifacts) {
        const absolute = join(evidenceDir, row.relativePath);
        expect(existsSync(absolute)).toBe(true);
        const bytes = readFileSync(absolute);
        expect(bytes.length).toBe(row.byteSize);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(row.sha256);
      }
      const htmlRow = artifacts.find((row) => row.kind === "HTML");
      expect(htmlRow?.sha256).toBe(
        createHash("sha256").update(FIXTURE_HTML, "utf8").digest("hex"),
      );

      const attempt = t.handle.db
        .select()
        .from(scrapeAttempts)
        .where(eq(scrapeAttempts.id, result.attemptId))
        .get();
      expect(attempt).toMatchObject({
        jobId: result.jobId,
        outcome: "SUCCEEDED",
        workerId: "clip",
      });

      const batch = t.handle.db
        .select()
        .from(intakeBatches)
        .where(eq(intakeBatches.id, result.batchId))
        .get();
      expect(batch).toMatchObject({ rawLineCount: 1, enqueuedCount: 1 });
      const item = t.handle.db
        .select()
        .from(intakeItems)
        .where(eq(intakeItems.id, result.intakeItemId))
        .get();
      expect(item).toMatchObject({
        outcome: "ENQUEUED",
        jobId: result.jobId,
        canonicalUrl: expect.stringContaining("example.com"),
      });
    });
  });

  it("reports duplicates without touching finished jobs", () => {
    withDatabase((t, evidenceDir) => {
      const first = ingestClippedDom(t.handle, {
        submittedUrl: CLIP_URL,
        html: FIXTURE_HTML,
        source: "clip",
        evidenceDir,
      });
      expect(first.outcome).toBe("created");
      if (first.outcome !== "created") return;
      // Even unusable bytes cannot regress a finished card.
      const second = ingestClippedDom(t.handle, {
        submittedUrl: `${CLIP_URL}?utm_source=x`,
        html: THIN_HTML,
        source: "clip",
        evidenceDir,
      });
      expect(second).toMatchObject({
        outcome: "duplicate",
        jobId: first.jobId,
        jobStatus: "NEW",
      });
      expect(t.handle.db.select().from(jobs).all()).toHaveLength(1);
      expect(t.handle.db.select().from(scrapeAttempts).all()).toHaveLength(1);
    });
  });

  it("completes failed shells instead of duplicating them", () => {
    withDatabase((t, evidenceDir) => {
      const failed = ingestClippedDom(t.handle, {
        submittedUrl: CLIP_URL,
        html: THIN_HTML,
        source: "clip",
        evidenceDir,
      });
      expect(failed.outcome).toBe("rejected");
      if (failed.outcome !== "rejected") return;
      expect(failed.reasonCode).toBe("EXTRACTION_INCOMPLETE");
      expect(failed.jobId).toBeTypeOf("string");

      const retry = ingestClippedDom(t.handle, {
        submittedUrl: CLIP_URL,
        html: FIXTURE_HTML,
        source: "clip",
        evidenceDir,
      });
      expect(retry.outcome).toBe("created");
      if (retry.outcome !== "created") return;
      expect(retry.jobId).toBe(failed.jobId);
      expect(t.handle.db.select().from(jobs).all()).toHaveLength(1);
    });
  });

  it("records blocked bytes without storing posting evidence", () => {
    withDatabase((t, evidenceDir) => {
      const result = ingestClippedDom(t.handle, {
        submittedUrl: CLIP_URL,
        html: CAPTCHA_HTML,
        title: "Verify you are human",
        source: "clip",
        evidenceDir,
      });
      expect(result.outcome).toBe("rejected");
      if (result.outcome !== "rejected") return;
      expect(result.reasonCode).toBe("CAPTCHA_REQUIRED");
      expect(result.jobId).toBeTypeOf("string");
      expect(t.handle.db.select().from(sourceArtifacts).all()).toHaveLength(0);
      const job = t.handle.db
        .select()
        .from(jobs)
        .where(eq(jobs.id, result.jobId as string))
        .get();
      expect(job?.scrapeState).toBe("BLOCKED");
      const item = t.handle.db
        .select()
        .from(intakeItems)
        .where(eq(intakeItems.id, result.intakeItemId))
        .get();
      expect(item?.outcome).toBe("BLOCKED");
    });
  });

  it("rejects invalid URLs and oversized pages", () => {
    withDatabase((t, evidenceDir) => {
      const invalid = ingestClippedDom(t.handle, {
        submittedUrl: "not a url",
        html: FIXTURE_HTML,
        source: "clip",
        evidenceDir,
      });
      expect(invalid).toMatchObject({
        outcome: "rejected",
        jobId: null,
        reasonCode: "INVALID_URL",
      });
      const huge = ingestClippedDom(t.handle, {
        submittedUrl: CLIP_URL,
        html: "x".repeat(5_000_001),
        source: "clip",
        evidenceDir,
      });
      expect(huge).toMatchObject({
        outcome: "rejected",
        reasonCode: "UNSUPPORTED_PAGE",
      });
      expect(t.handle.db.select().from(jobs).all()).toHaveLength(0);
      expect(t.handle.db.select().from(jobSources).all()).toHaveLength(0);
    });
  });

  it("prefers user-selected text and tags paste provenance", () => {
    withDatabase((t, evidenceDir) => {
      const result = ingestClippedDom(t.handle, {
        submittedUrl: CLIP_URL,
        html: FIXTURE_HTML,
        selectedText: "Staff Engineer at Gamma LLC, remote-first.",
        source: "paste",
        evidenceDir,
      });
      expect(result.outcome).toBe("created");
      if (result.outcome !== "created") return;
      const textRow = t.handle.db
        .select()
        .from(sourceArtifacts)
        .all()
        .find((row) => row.kind === "TEXT");
      const stored = readFileSync(join(evidenceDir, textRow?.relativePath ?? ""), "utf8");
      expect(stored).toBe("Staff Engineer at Gamma LLC, remote-first.");
      const attempt = t.handle.db
        .select()
        .from(scrapeAttempts)
        .where(eq(scrapeAttempts.id, result.attemptId))
        .get();
      expect(attempt?.workerId).toBe("paste");
    });
  });

  it("clips private-network URLs without DNS (no fetch, no SSRF)", () => {
    withDatabase((t, evidenceDir) => {
      const result = ingestClippedDom(t.handle, {
        submittedUrl: "http://192.168.1.10/jobs/1",
        html: FIXTURE_HTML,
        source: "clip",
        evidenceDir,
      });
      expect(result.outcome).toBe("created");
    });
  });
});
