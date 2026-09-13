// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  candidateProfileVersions,
  candidateProfiles,
  candidateSnapshots,
  jdSnapshots,
  jobAnalyses,
  jobExtractions,
  jobs,
  newId,
  openDatabase,
  resumeArtifacts,
  resumeVersions,
  scrapeAttempts,
  type DatabaseHandle,
} from "../../../src/db";
import { POST as approve } from "../../../app/api/jobs/[id]/resume/approve/route";
import { POST as revise } from "../../../app/api/jobs/[id]/resume/revise/route";
import { GET as review } from "../../../app/api/resumes/[id]/review/route";
import { GET as resumeFile } from "../../../app/api/resumes/artifacts/[id]/route";
import {
  getRequest,
  postRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

/**
 * R4-F route tests: approval, revision, review projection, and artifact
 * file serving against an isolated data root with real artifact bytes.
 */

const NOW = "2026-09-11T12:00:00.000Z";

describe("resume review routes", () => {
  let isolated: IsolatedRoot;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-review-routes-test-");
    mkdirSync(join(isolated.root, "artifacts"), { recursive: true });
  });

  afterEach(() => {
    isolated.restoreEnv();
    isolated.cleanup();
  });

  function dbPath(): string {
    return join(isolated.root, "job-tracker.sqlite");
  }

  function artifactsDir(): string {
    return join(isolated.root, "artifacts");
  }

  function withDb<T>(fn: (handle: DatabaseHandle) => T): T {
    const handle = openDatabase({ path: dbPath() });
    try {
      return fn(handle);
    } finally {
      handle.close();
    }
  }

  function seedReviewable(): { jobId: string; versionId: string; artifactId: string } {
    const jobId = newId();
    const versionId = newId();
    let markdownId = "";
    withDb((handle) => {
      handle.db
        .insert(jobs)
        .values({ id: jobId, status: "NEW", rank: 0, rowVersion: 1, tailoringState: "AWAITING_REVIEW" })
        .run();
      handle.db
        .insert(candidateProfiles)
        .values({ id: "local", name: "default", displayName: "Primary Profile", isDefault: true })
        .run();
      const profileVersionId = newId();
      handle.db
        .insert(candidateProfileVersions)
        .values({
          id: profileVersionId,
          profileId: "local",
          version: 1,
          payloadJson: "{}",
          payloadHash: "0".repeat(64),
          schemaVersion: "candidate-profile-v1",
        })
        .run();
      const candidateSnapshotId = newId();
      handle.db
        .insert(candidateSnapshots)
        .values({
          id: candidateSnapshotId,
          profileVersionId,
          canonicalJson: "{}",
          schemaVersion: "candidate-snapshot-v1",
          sha256: "1".repeat(64),
        })
        .run();
      const attemptId = newId();
      handle.db
        .insert(scrapeAttempts)
        .values({
          id: attemptId,
          jobId,
          canonicalUrl: "https://example.com/jobs/1",
          startedAt: NOW,
          finishedAt: NOW,
          outcome: "SUCCEEDED",
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
          adapter: "test",
          extractedJson: "{}",
        })
        .run();
      handle.db.update(jobs).set({ activeExtractionId: extractionId }).where(eq(jobs.id, jobId)).run();
      const jdSnapshotId = newId();
      handle.db
        .insert(jdSnapshots)
        .values({
          id: jdSnapshotId,
          jobId,
          extractionId,
          jdText: "TypeScript API experience.",
          canonicalSha256: "2".repeat(64),
        })
        .run();
      const analysisId = newId();
      handle.db
        .insert(jobAnalyses)
        .values({
          id: analysisId,
          jobId,
          jdSnapshotId,
          candidateSnapshotId,
          requirementsJson: JSON.stringify({
            schemaVersion: "analysis-requirements/v1",
            requirements: [
              {
                requirement_id: "req_api",
                jd_quote: "TypeScript API experience",
                category: "skill",
                importance: "required",
                match_status: "matched",
                evidence_fact_ids: ["f1"],
                evidence_quotes: [],
                review_status: "confirmed",
              },
            ],
          }),
          gapsJson: JSON.stringify({ schemaVersion: "analysis-gaps/v1", gaps: [] }),
          promptVersion: "tailor-prompt/v1",
          proposalSchemaVersion: "resume-proposal/v1",
        })
        .run();
      handle.db
        .insert(resumeVersions)
        .values({
          id: versionId,
          jobId,
          version: 1,
          parentVersionId: null,
          analysisId,
          templateId: "standard",
          templateVersion: "v1",
          templateHash: "t".repeat(64),
          rankerVersion: "ranker-v1",
          policyVersion: "policy-v1",
          configVersion: "config-v1",
          renderSchemaVersion: "render-v1",
          contentJson: JSON.stringify({
            schemaVersion: "resume-content/v1",
            summaryStrategy: "fact-grounded",
            omittedUnsupported: [],
            changeSummary: {
              addedBullets: [],
              removedBullets: [],
              summaryChanged: false,
              baselineLines: 10,
              tailoredLines: 10,
            },
            audit: {
              requirementsTotal: 1,
              supportedCount: 1,
              gapCount: 0,
              validatedClaims: 0,
              totalClaims: 0,
              rationale: "Supported.",
              questions: [],
            },
          }),
          contentHash: "c".repeat(64),
          reviewState: "AWAITING_REVIEW",
        })
        .run();
      handle.db.update(jobs).set({ activeResumeVersionId: versionId }).where(eq(jobs.id, jobId)).run();
      const specs = [
        { kind: "MARKDOWN", extension: "md", mediaType: "text/markdown; charset=utf-8" },
        {
          kind: "DOCX",
          extension: "docx",
          mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
        { kind: "PDF", extension: "pdf", mediaType: "application/pdf" },
      ] as const;
      for (const spec of specs) {
        const bytes = Buffer.from(`route-test-${spec.kind.toLowerCase()}-bytes`, "utf8");
        const relativePath = `resumes/${jobId}/v1_cccccccc.${spec.extension}`;
        mkdirSync(join(artifactsDir(), `resumes/${jobId}`), { recursive: true });
        writeFileSync(join(artifactsDir(), relativePath), bytes);
        const id = newId();
        if (spec.kind === "MARKDOWN") {
          markdownId = id;
        }
        handle.db
          .insert(resumeArtifacts)
          .values({
            id,
            resumeVersionId: versionId,
            kind: spec.kind,
            relativePath,
            mediaType: spec.mediaType,
            byteSize: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          })
          .run();
      }
    });
    return { jobId, versionId, artifactId: markdownId };
  }

  function jobRow(jobId: string) {
    return withDb((handle) => handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get());
  }

  it("gates every review route by host and origin", async () => {
    const seed = seedReviewable();
    const noOrigin = await approve(
      postRequest(
        `/api/jobs/${seed.jobId}/resume/approve`,
        { resumeVersionId: seed.versionId, observedRowVersion: 1 },
        { host: "127.0.0.1:3000", origin: "" },
      ),
      routeParams(seed.jobId),
    );
    expect(noOrigin.status).toBe(403);
    const foreignOrigin = await revise(
      postRequest(
        `/api/jobs/${seed.jobId}/resume/revise`,
        { resumeVersionId: seed.versionId, observedRowVersion: 1, note: "x" },
        { host: "127.0.0.1:3000", origin: "http://evil.example" },
      ),
      routeParams(seed.jobId),
    );
    expect(foreignOrigin.status).toBe(403);
    const badHost = await review(
      getRequest(`/api/resumes/${seed.versionId}/review`, { host: "evil.example" }),
      routeParams(seed.versionId),
    );
    expect(badHost.status).toBe(403);
    const badFileHost = await resumeFile(
      getRequest(`/api/resumes/artifacts/${seed.artifactId}`, { host: "evil.example" }),
      routeParams(seed.artifactId),
    );
    expect(badFileHost.status).toBe(403);
  });

  it("approves through the route and persists the Tailored move", async () => {
    const seed = seedReviewable();
    const response = await approve(
      postRequest(`/api/jobs/${seed.jobId}/resume/approve`, {
        resumeVersionId: seed.versionId,
        observedRowVersion: 1,
        note: "Looks right.",
      }),
      routeParams(seed.jobId),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body["reviewId"]).toBeTypeOf("string");
    expect(body["eventId"]).toBeTypeOf("string");
    expect(body["newRowVersion"]).toBe(2);
    expect(jobRow(seed.jobId)).toMatchObject({ status: "TAILORED", tailoringState: "APPROVED" });
  });

  it("maps approval failures to status codes and refuses forged actors", async () => {
    const seed = seedReviewable();
    const stale = await approve(
      postRequest(`/api/jobs/${seed.jobId}/resume/approve`, {
        resumeVersionId: seed.versionId,
        observedRowVersion: 99,
      }),
      routeParams(seed.jobId),
    );
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toMatchObject({ error: "conflict", currentRowVersion: 1 });

    const unknownJob = newId();
    const missing = await approve(
      postRequest(`/api/jobs/${unknownJob}/resume/approve`, {
        resumeVersionId: seed.versionId,
        observedRowVersion: 1,
      }),
      routeParams(unknownJob),
    );
    expect(missing.status).toBe(404);

    const malformed = await approve(
      postRequest("/api/jobs/not-a-uuid/resume/approve", {
        resumeVersionId: seed.versionId,
        observedRowVersion: 1,
      }),
      routeParams("not-a-uuid"),
    );
    expect(malformed.status).toBe(400);

    // The actor is forced server-side: a smuggled agent actor is a schema
    // violation, not an approval.
    const forged = await approve(
      postRequest(`/api/jobs/${seed.jobId}/resume/approve`, {
        resumeVersionId: seed.versionId,
        observedRowVersion: 1,
        actor: "agent",
      }),
      routeParams(seed.jobId),
    );
    expect(forged.status).toBe(400);
    expect(jobRow(seed.jobId)?.status).toBe("NEW");
  });

  it("fails approval loudly on tampered bytes", async () => {
    const seed = seedReviewable();
    const relative = withDb((handle) =>
      handle.db
        .select()
        .from(resumeArtifacts)
        .where(eq(resumeArtifacts.resumeVersionId, seed.versionId))
        .all()
        .find((row) => row.kind === "PDF")?.relativePath,
    );
    writeFileSync(join(artifactsDir(), relative as string), Buffer.from("tampered", "utf8"));
    const response = await approve(
      postRequest(`/api/jobs/${seed.jobId}/resume/approve`, {
        resumeVersionId: seed.versionId,
        observedRowVersion: 1,
      }),
      routeParams(seed.jobId),
    );
    expect(response.status).toBe(500);
    expect(await readJson(response)).toMatchObject({ error: "artifact-mismatch" });
    expect(jobRow(seed.jobId)?.status).toBe("NEW");
  });

  it("requests revision through the route and requires a note", async () => {
    const seed = seedReviewable();
    const noNote = await revise(
      postRequest(`/api/jobs/${seed.jobId}/resume/revise`, {
        resumeVersionId: seed.versionId,
        observedRowVersion: 1,
      }),
      routeParams(seed.jobId),
    );
    expect(noNote.status).toBe(400);
    const response = await revise(
      postRequest(`/api/jobs/${seed.jobId}/resume/revise`, {
        resumeVersionId: seed.versionId,
        observedRowVersion: 1,
        note: "Second bullet is wrong.",
      }),
      routeParams(seed.jobId),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body["workItemId"]).toBeTypeOf("string");
    expect(jobRow(seed.jobId)).toMatchObject({ status: "NEW", tailoringState: "REVISION_REQUESTED" });

    const unknownVersion = await revise(
      postRequest(`/api/jobs/${seed.jobId}/resume/revise`, {
        resumeVersionId: newId(),
        observedRowVersion: 2,
        note: "Note.",
      }),
      routeParams(seed.jobId),
    );
    expect(unknownVersion.status).toBe(404);
  });

  it("serves the review projection and artifact bytes by id", async () => {
    const seed = seedReviewable();
    const view = await review(
      getRequest(`/api/resumes/${seed.versionId}/review`),
      routeParams(seed.versionId),
    );
    expect(view.status).toBe(200);
    const body = (await view.json()) as {
      version: { version: number };
      analysis: { requirements: unknown[] } | null;
      artifacts: Array<{ kind: string }>;
      actions: { canApprove: boolean };
    };
    expect(body.version.version).toBe(1);
    expect(body.analysis?.requirements).toHaveLength(1);
    expect(body.artifacts).toHaveLength(3);
    expect(body.actions.canApprove).toBe(true);

    const missingView = await review(getRequest("/api/resumes/x/review"), routeParams(newId()));
    expect(missingView.status).toBe(404);
    const malformedView = await review(getRequest("/api/resumes/x/review"), routeParams("nope"));
    expect(malformedView.status).toBe(400);

    const file = await resumeFile(
      getRequest(`/api/resumes/artifacts/${seed.artifactId}`),
      routeParams(seed.artifactId),
    );
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toContain("text/markdown");
    expect(await file.text()).toContain("route-test-markdown-bytes");

    const download = await resumeFile(
      getRequest(`/api/resumes/artifacts/${seed.artifactId}?download=1`),
      routeParams(seed.artifactId),
    );
    expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="resume-markdown-[0-9a-f]{8}\.md"$/);

    const missingFile = await resumeFile(getRequest("/api/resumes/artifacts/x"), routeParams(newId()));
    expect(missingFile.status).toBe(404);
  });
});
