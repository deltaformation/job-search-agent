// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GET as artifactGET } from "../../../app/api/resumes/artifacts/[id]/route";
import { eq } from "drizzle-orm";
import {
  newId,
  openDatabase,
  resumeArtifacts,
  type TestDatabase,
} from "../../../src/db";
import { assertProjectionContains } from "../../../src/resumes/checks";
import { extractPdfText } from "../../../src/resumes/pdf";
import { readTailoredMarkdown } from "../../../src/server/workflowReview";
import { TestProvider } from "../../../src/tailoring/testProvider";
import { sha256HexUtf8 } from "../../../src/tailoring/hash";
import { seedCrossProfileWorld } from "../acceptance-v1.2/world";
import {
  seedV13Basics,
  seedV13RequestInputs,
  seedV13RunningRun,
  seedV13Version,
} from "../db/v13world";
import {
  getRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "../routes/_helpers";
import {
  claimFRun,
  factTextsForVersion,
  fHandler,
  makeArtifactsDir,
  proposalForRun,
  q6,
  seedFRun,
  withFDatabase,
  F_T0,
} from "./f-world";

/**
 * WO-1.3-G acceptance: G7 (exact-byte artifact serving, traversal
 * denial, integrity failures) and G8 (canonical-text equality,
 * cross-format parity assertions, failed parity prevents publish).
 * Route legs run against an isolated data root; the parity leg runs
 * the real worker handler with a stubbed PDF renderer.
 */

const tempDirs: string[] = [];
let isolated: IsolatedRoot | null = null;

afterEach(() => {
  isolated?.restoreEnv();
  isolated?.cleanup();
  isolated = null;
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

/** Minimal one-page PDF whose extracted text is exactly `text`. */
function fillerPdf(text: string): Buffer {
  const safe = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const words = safe.split(" ");
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 12) {
    lines.push(`(${words.slice(i, i + 12).join(" ")}) Tj 0 -14 Td`);
  }
  const stream = `BT /F1 12 Tf 72 720 Td ${lines.join(" ")} ET`;
  return Buffer.from(
    `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${Buffer.byteLength(stream, "utf8")} >> stream
${stream}
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
`,
    "utf8",
  );
}

function seedPdfWorld(): { artifactId: string; pdfBytes: Buffer; versionId: string } {
  isolated = setupIsolatedRoot("g-artifacts-");
  mkdirSync(join(isolated.root, "artifacts"), { recursive: true });
  const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
  try {
    const world = seedCrossProfileWorld({ handle } as TestDatabase);
    const basics = seedV13Basics(handle, world);
    const run = seedV13RunningRun(handle, basics);
    seedV13RequestInputs(handle, basics, run);
    const version = seedV13Version(handle, basics, run);
    const pdfBytes = fillerPdf("Avery Stone resume body text for exact-byte serving.");
    const relativePath = `versions/${version.versionId}/resume.pdf`;
    mkdirSync(join(isolated.root, "artifacts", `versions/${version.versionId}`), {
      recursive: true,
    });
    writeFileSync(join(isolated.root, "artifacts", relativePath), pdfBytes);
    const artifactId = newId();
    handle.db
      .insert(resumeArtifacts)
      .values({
        id: artifactId,
        resumeVersionId: version.versionId,
        kind: "PDF",
        relativePath,
        mediaType: "application/pdf",
        byteSize: pdfBytes.byteLength,
        sha256: createHash("sha256").update(pdfBytes).digest("hex"),
      })
      .run();
    return { artifactId, pdfBytes, versionId: version.versionId };
  } finally {
    handle.close();
  }
}

describe("G7 exact artifact serving", () => {
  it("serves the exact PDF bytes with the recorded hash", async () => {
    const { artifactId, pdfBytes } = seedPdfWorld();
    const response = await artifactGET(
      getRequest(`/api/resumes/artifacts/${artifactId}`),
      routeParams(artifactId),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const served = Buffer.from(await response.arrayBuffer());
    expect(served.equals(pdfBytes)).toBe(true);
  });

  it("denies unknown ids, malformed ids, and traversal paths", async () => {
    const { versionId } = seedPdfWorld();
    const missing = await artifactGET(
      getRequest(`/api/resumes/artifacts/${newId()}`),
      routeParams(newId()),
    );
    expect(missing.status).toBe(404);
    const malformed = await artifactGET(getRequest("/api/resumes/artifacts/not-an-id"), routeParams("not-an-id"));
    expect(malformed.status).toBe(400);
    // A traversal row can exist only by direct DB write; serving still refuses.
    const handle = openDatabase({
      path: join((isolated as IsolatedRoot).root, "job-tracker.sqlite"),
    });
    const traversalId = newId();
    try {
      handle.db
        .insert(resumeArtifacts)
        .values({
          id: traversalId,
          resumeVersionId: versionId,
          kind: "MARKDOWN",
          relativePath: "../../job-tracker.sqlite",
          mediaType: "text/markdown",
          byteSize: 8,
          sha256: "0".repeat(64),
        })
        .run();
    } finally {
      handle.close();
    }
    const traversal = await artifactGET(
      getRequest(`/api/resumes/artifacts/${traversalId}`),
      routeParams(traversalId),
    );
    expect(traversal.status).toBe(500);
    expect(await readJson(traversal)).toMatchObject({ error: "artifact path rejected" });
  });

  it("fails integrity instead of serving corrupt bytes", async () => {
    const { artifactId } = seedPdfWorld();
    const root = (isolated as IsolatedRoot).root;
    const handle = openDatabase({ path: join(root, "job-tracker.sqlite") });
    let relativePath = "";
    try {
      const row = handle.db
        .select()
        .from(resumeArtifacts)
        .where(eq(resumeArtifacts.id, artifactId))
        .get();
      relativePath = row?.relativePath ?? "";
    } finally {
      handle.close();
    }
    // Flip one byte after publication: size matches, digest does not.
    const absolute = join(root, "artifacts", relativePath);
    const bytes = readFileSync(absolute);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff;
    writeFileSync(absolute, bytes);
    const response = await artifactGET(
      getRequest(`/api/resumes/artifacts/${artifactId}`),
      routeParams(artifactId),
    );
    expect(response.status).toBe(500);
    expect(await readJson(response)).toMatchObject({ error: "artifact integrity failure" });
  });
});

describe("G8 canonical text and parity", () => {
  it("reads the exact canonical bytes and reports tampering", () => {
    const dir = mkdtempSync(join(tmpdir(), "g-canonical-"));
    tempDirs.push(dir);
    const text = "# Avery Stone\n\nProduct leader.\n";
    mkdirSync(join(dir, "v"), { recursive: true });
    writeFileSync(join(dir, "v/resume.md"), text, "utf8");
    const row = {
      kind: "MARKDOWN",
      relativePath: "v/resume.md",
      byteSize: Buffer.byteLength(text, "utf8"),
      sha256: sha256HexUtf8(text),
    };
    expect(readTailoredMarkdown([row], dir)).toEqual({ text, status: "ok" });
    expect(readTailoredMarkdown([row], undefined)).toEqual({ text: "", status: "unchecked" });
    expect(readTailoredMarkdown([], dir)).toEqual({ text: "", status: "missing" });
    writeFileSync(join(dir, "v/resume.md"), `${text}tampered`, "utf8");
    expect(readTailoredMarkdown([row], dir)).toEqual({ text: "", status: "mismatch" });
  });

  it("asserts fragment containment across projections", () => {
    expect(() =>
      assertProjectionContains(["Led Platform Roadmap", "billing"], "led   platform\nroadmap+billing", "PDF"),
    ).not.toThrow();
    expect(() => assertProjectionContains([], "anything", "Markdown")).not.toThrow();
    expect(() => assertProjectionContains(["Kubernetes deployments"], "Led platform work.", "DOCX")).toThrow(
      'DOCX is missing expected resume text: "Kubernetes deployments".',
    );
  });

  it("failed parity prevents publish with zero versions", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const facts = factTextsForVersion(t.handle, run.basics.profileVersionId);
      const proposal = proposalForRun({
        recommendations: run.recommendations,
        factTexts: facts,
        jdSnapshotId: run.jdSnapshotId,
        candidateSnapshotId: run.candidateSnapshotId,
      });
      const first = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const provider = new TestProvider({ proposals: { [run.jdSnapshotId]: proposal } });
      // The stubbed PDF parses and clears the text minimum but
      // carries none of the resume fragments: parity must fail.
      const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(12);
      const stubBytes = fillerPdf(filler);
      const extracted = await extractPdfText(stubBytes);
      expect(extracted.pageCount).toBe(1);
      expect(extracted.text.trim().length).toBeGreaterThanOrEqual(300);
      const artifactsDir = makeArtifactsDir();
      tempDirs.push(artifactsDir);
      const failed = await fHandler({
        artifactsDir,
        provider,
        clock: () => F_T0,
        renderPdf: async () => ({ bytes: stubBytes }),
      })(first.context);
      expect(failed).toMatchObject({ result: "FAILED", errorCode: "RENDER_FAILED" });
      // Extraction and budget pass (proven above), so the render
      // failure isolates to the fragment-containment assertion.
      const detail = JSON.parse(
        (failed as { errorDetail: string }).errorDetail,
      ) as { failure: { code: string; stage: string } };
      expect(detail.failure).toMatchObject({ code: "RENDER_FAILED", stage: "RENDERING_ARTIFACTS" });
      expect(q6(t.handle, run.requestId)).toEqual({ analyses: 1, versions: 0 });
    });
  }, 30_000);
});
