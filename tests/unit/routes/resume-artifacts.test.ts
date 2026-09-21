// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  candidateProfiles,
  candidateProfileVersions,
  candidateSnapshots,
  generationRequests,
  jdSnapshots,
  jobAnalyses,
  jobExtractions,
  jobs,
  newId,
  openDatabase,
  resumeArtifacts,
  resumeVersions,
  scrapeAttempts,
  workAttempts,
  workItems,
  type DatabaseHandle,
} from "../../../src/db";
import { canonicalJson } from "../../../src/domain/canonical";
import { loadDocxTemplateBytes, renderDocx } from "../../../src/resumes/docx";
import type { ResumeViewModel } from "../../../src/resumes/viewModel";
import { GET as serveFile } from "../../../app/api/resumes/artifacts/[id]/route";
import { GET as serveContent } from "../../../app/api/resumes/artifacts/[id]/content/route";
import {
  getRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

/**
 * Resume artifact routes (WO-1.2-F, F3): stored bytes served by id
 * with preview/download semantics, plus the canonical DOCX content
 * preview — all against an isolated root with real rendered bytes.
 */

const NOW = "2026-09-11T12:00:00.000Z";
const HOSTILE_BULLET = "<script>alert('xss')</script> & \"quoted\"";

function hostileModel(): ResumeViewModel {
  return {
    header: { full_name: "Test Candidate", contact_parts: [] },
    summary_copy: "",
    professional_experience: [
      {
        company: "Acme",
        role: "Engineer",
        location: "Remote",
        dates: "Jan 2020 - Present",
        bullets: [HOSTILE_BULLET, "Shipped reliable systems."],
      },
    ],
    earlier_career: [],
    skill_rows: [],
    education_rows: [],
  };
}

describe("resume artifact routes", () => {
  let isolated: IsolatedRoot;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-artifact-routes-test-");
    mkdirSync(join(isolated.root, "artifacts"), { recursive: true });
  });

  afterEach(() => {
    isolated.restoreEnv();
    isolated.cleanup();
  });

  function artifactsDir(): string {
    return join(isolated.root, "artifacts");
  }

  function withDb<T>(fn: (handle: DatabaseHandle) => T): T {
    const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
    try {
      return fn(handle);
    } finally {
      handle.close();
    }
  }

  function seedVersionWithDocx(): { docxId: string; markdownId: string; hostileId: string } {
    return withDb((handle) => {
      const jobId = newId();
      handle.db
        .insert(jobs)
        .values({ id: jobId, status: "NEW", rank: 0, rowVersion: 1, tailoringState: "READY" })
        .run();
      handle.db
        .insert(candidateProfiles)
        .values({ id: "pm", name: "pm", displayName: "Product Manager", isDefault: true })
        .run();
      const profileVersionId = newId();
      handle.db
        .insert(candidateProfileVersions)
        .values({
          id: profileVersionId,
          profileId: "pm",
          version: 1,
          payloadJson: "{}",
          payloadHash: "c".repeat(64),
          schemaVersion: "candidate-profile-v1",
        })
        .run();
      const snapshotId = newId();
      handle.db
        .insert(candidateSnapshots)
        .values({
          id: snapshotId,
          profileVersionId,
          canonicalJson: "{}",
          schemaVersion: "candidate-snapshot-v1",
          sha256: "d".repeat(64),
        })
        .run();
      const attemptId = newId();
      handle.db
        .insert(scrapeAttempts)
        .values({
          id: attemptId,
          jobId,
          canonicalUrl: "https://example.com/jobs/7",
          startedAt: NOW,
          finishedAt: NOW,
          outcome: "SUCCEEDED",
          workerId: "worker-a",
        })
        .run();
      const extractionId = newId();
      handle.db
        .insert(jobExtractions)
        .values({
          id: extractionId,
          jobId,
          scrapeAttemptId: attemptId,
          version: 1,
          schemaVersion: "job-extraction-v1",
          adapter: "generic",
          extractedJson: "{}",
        })
        .run();
      const jdSnapshotId = newId();
      handle.db
        .insert(jdSnapshots)
        .values({
          id: jdSnapshotId,
          jobId,
          extractionId,
          jdText: "Product Manager",
          canonicalSha256: "e".repeat(64),
        })
        .run();
      const requestId = newId();
      const queueItemId = newId();
      const queueAttemptId = newId();
      handle.db
        .insert(workItems)
        .values({
          id: queueItemId,
          kind: "TAILOR",
          idempotencyKey: `genreq:v1:${requestId}`,
          jobId,
          payloadJson: canonicalJson({
            schemaVersion: "tailor-queue/v2",
            generationRequestId: requestId,
            jobId,
            extractionId,
            profileId: "pm",
            profileVersionId,
            jdSnapshotId,
            payloadHash: "0".repeat(64),
          }),
          state: "SUCCEEDED",
          attemptCount: 1,
          maxAttempts: 3,
        })
        .run();
      handle.db
        .insert(generationRequests)
        .values({
          id: requestId,
          requestIdentity: `genreq:v1:${requestId}`,
          jobId,
          extractionId,
          profileId: "pm",
          profileVersionId,
          jdSnapshotId,
          requestKind: "INITIAL",
          steeringSnapshotJson: "{}",
          selectedKeywordsJson: "[]",
          payloadHash: "0".repeat(64),
          status: "SUCCEEDED",
          workItemId: queueItemId,
        })
        .run();
      handle.db
        .insert(workAttempts)
        .values({
          id: queueAttemptId,
          workItemId: queueItemId,
          attemptNumber: 1,
          workerId: "worker-a",
          startedAt: NOW,
          finishedAt: NOW,
          result: "SUCCEEDED",
        })
        .run();
      const analysisId = newId();
      handle.db
        .insert(jobAnalyses)
        .values({
          id: analysisId,
          jobId,
          jdSnapshotId,
          candidateSnapshotId: snapshotId,
          generationRequestId: requestId,
          workAttemptId: queueAttemptId,
          requirementsJson: JSON.stringify({
            schemaVersion: "analysis-requirements/v1",
            requirements: [],
          }),
          gapsJson: JSON.stringify({ schemaVersion: "analysis-gaps/v1", gaps: [] }),
          promptVersion: "tailor-prompt/v1",
          proposalSchemaVersion: "resume-proposal/v1",
        })
        .run();
      const versionId = newId();
      handle.db
        .insert(resumeVersions)
        .values({
          id: versionId,
          jobId,
          version: 1,
          parentVersionId: null,
          analysisId,
          generationRequestId: requestId,
          workAttemptId: queueAttemptId,
          templateId: "standard",
          templateVersion: "v1",
          templateHash: "t".repeat(64),
          rankerVersion: "ranker-v1",
          policyVersion: "policy-v1",
          configVersion: "config-v1",
          renderSchemaVersion: "render-v1",
          contentJson: "{}",
          contentHash: "f".repeat(64),
          reviewState: "AWAITING_REVIEW",
        })
        .run();

      mkdirSync(join(artifactsDir(), `resumes/${jobId}`), { recursive: true });
      const store = (
        kind: "DOCX" | "MARKDOWN",
        fileName: string,
        mediaType: string,
        bytes: Buffer,
      ): string => {
        const relativePath = `resumes/${jobId}/${fileName}`;
        writeFileSync(join(artifactsDir(), relativePath), bytes);
        const id = newId();
        handle.db
          .insert(resumeArtifacts)
          .values({
            id,
            resumeVersionId: versionId,
            kind,
            relativePath,
            mediaType,
            byteSize: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          })
          .run();
        return id;
      };
      const docxId = store(
        "DOCX",
        "v1.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        renderDocx(hostileModel(), loadDocxTemplateBytes()),
      );
      const markdownId = store("MARKDOWN", "v1.md", "text/markdown; charset=utf-8", Buffer.from(
        `# Test Candidate\n\n${HOSTILE_BULLET}\n`,
        "utf8",
      ));
      // The hostile row needs its own version: (version, kind) is unique,
      // and v13 requires its own request + analysis too
      // (one version and one analysis per (request, attempt)).
      const hostileRequestId = newId();
      const hostileQueueItemId = newId();
      handle.db
        .insert(workItems)
        .values({
          id: hostileQueueItemId,
          kind: "TAILOR",
          idempotencyKey: `genreq:v1:${hostileRequestId}`,
          jobId,
          payloadJson: canonicalJson({
            schemaVersion: "tailor-queue/v2",
            generationRequestId: hostileRequestId,
            jobId,
            extractionId,
            profileId: "pm",
            profileVersionId,
            jdSnapshotId,
            payloadHash: "0".repeat(64),
          }),
          state: "SUCCEEDED",
          attemptCount: 1,
          maxAttempts: 3,
        })
        .run();
      handle.db
        .insert(generationRequests)
        .values({
          id: hostileRequestId,
          requestIdentity: `genreq:v1:${hostileRequestId}`,
          jobId,
          extractionId,
          profileId: "pm",
          profileVersionId,
          jdSnapshotId,
          requestKind: "INITIAL",
          steeringSnapshotJson: "{}",
          selectedKeywordsJson: "[]",
          payloadHash: "0".repeat(64),
          status: "SUCCEEDED",
          workItemId: hostileQueueItemId,
        })
        .run();
      const hostileAnalysisId = newId();
      handle.db
        .insert(jobAnalyses)
        .values({
          id: hostileAnalysisId,
          jobId,
          jdSnapshotId,
          candidateSnapshotId: snapshotId,
          workAttemptId: queueAttemptId,
          generationRequestId: hostileRequestId,
          requirementsJson: "[]",
          gapsJson: "[]",
          promptVersion: "tailor-prompt/v1",
          proposalSchemaVersion: "resume-proposal/v1",
        })
        .run();
      const hostileVersionId = newId();
      handle.db
        .insert(resumeVersions)
        .values({
          id: hostileVersionId,
          jobId,
          version: 2,
          parentVersionId: null,
          analysisId: hostileAnalysisId,
          generationRequestId: hostileRequestId,
          workAttemptId: queueAttemptId,
          templateId: "standard",
          templateVersion: "v1",
          templateHash: "t".repeat(64),
          rankerVersion: "ranker-v1",
          policyVersion: "policy-v1",
          configVersion: "config-v1",
          renderSchemaVersion: "render-v1",
          contentJson: "{}",
          contentHash: "e".repeat(64),
          reviewState: "AWAITING_REVIEW",
        })
        .run();
      const hostileId = newId();
      handle.db
        .insert(resumeArtifacts)
        .values({
          id: hostileId,
          resumeVersionId: hostileVersionId,
          kind: "DOCX",
          relativePath: "resumes/../../etc/passwd",
          mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          byteSize: 8,
          sha256: "9".repeat(64),
        })
        .run();
      expect(
        handle.db.select().from(resumeArtifacts).where(eq(resumeArtifacts.id, hostileId)).get(),
      ).not.toBeUndefined();
      return { docxId, markdownId, hostileId };
    });
  }

  it("serves stored bytes inline with sandboxing headers, or as a named download", async () => {
    const seed = seedVersionWithDocx();
    const inline = await serveFile(
      getRequest(`/api/resumes/artifacts/${seed.markdownId}`),
      routeParams(seed.markdownId),
    );
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-type")).toContain("text/markdown");
    expect(inline.headers.get("content-security-policy")).toBe("sandbox");
    expect(inline.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await inline.text()).toContain(HOSTILE_BULLET);

    const download = await serveFile(
      getRequest(`/api/resumes/artifacts/${seed.docxId}?download=1`),
      routeParams(seed.docxId),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toMatch(
      /^attachment; filename="resume-docx-[0-9a-f]{8}\.docx"$/,
    );

    const missing = await serveFile(getRequest("/api/resumes/artifacts/x"), routeParams(newId()));
    expect(missing.status).toBe(404);
    const malformed = await serveFile(getRequest("/api/resumes/artifacts/x"), routeParams("nope"));
    expect(malformed.status).toBe(400);
  });

  it("rejects traversal paths without touching the filesystem", async () => {
    const seed = seedVersionWithDocx();
    const response = await serveFile(
      getRequest(`/api/resumes/artifacts/${seed.hostileId}`),
      routeParams(seed.hostileId),
    );
    expect(response.status).toBe(500);
    expect(await readJson(response)).toMatchObject({ error: "artifact path rejected" });
  });

  it("previews DOCX content as escaped, labeled, sandboxed HTML", async () => {
    const seed = seedVersionWithDocx();
    const response = await serveContent(
      getRequest(`/api/resumes/artifacts/${seed.docxId}/content`),
      routeParams(seed.docxId),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const page = await response.text();
    // Labeled as a content preview with original access, never pixel-exact.
    expect(page).toContain("Content preview");
    expect(page).toContain("may differ from the original");
    expect(page).toContain(`/api/resumes/artifacts/${seed.docxId}?download=1`);
    // Real extracted content, hostile text escaped.
    expect(page).toContain("Shipped reliable systems.");
    expect(page).toContain("&lt;script&gt;");
    expect(page).not.toContain("<script>alert");
    expect(page).toContain("&amp;");
    expect(page).toContain("&#34;quoted&#34;");
  });

  it("refuses content previews for non-DOCX, missing, malformed, and traversal rows", async () => {
    const seed = seedVersionWithDocx();
    const markdown = await serveContent(
      getRequest(`/api/resumes/artifacts/${seed.markdownId}/content`),
      routeParams(seed.markdownId),
    );
    expect(markdown.status).toBe(400);

    const missing = await serveContent(
      getRequest("/api/resumes/artifacts/x/content"),
      routeParams(newId()),
    );
    expect(missing.status).toBe(404);

    const malformed = await serveContent(
      getRequest("/api/resumes/artifacts/x/content"),
      routeParams("nope"),
    );
    expect(malformed.status).toBe(400);

    const traversal = await serveContent(
      getRequest(`/api/resumes/artifacts/${seed.hostileId}/content`),
      routeParams(seed.hostileId),
    );
    expect(traversal.status).toBe(500);
    expect(await readJson(traversal)).toMatchObject({ error: "artifact path rejected" });
  });
});
