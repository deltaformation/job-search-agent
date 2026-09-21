// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  resumeClaims,
  resumeVersions,
  scrapeAttempts,
  workAttempts,
  workItems,
  type DatabaseHandle,
} from "../../../src/db";
import { SteeringSnapshotV1 } from "../../../src/tailoring/requests";
import {
  activateProfileVersion,
  importCandidate,
} from "../../../src/server/candidates";
import { POST as approve } from "../../../app/api/jobs/[id]/resume/approve/route";
import { POST as decline } from "../../../app/api/jobs/[id]/resume/decline/route";
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
        .values({
          id: jobId,
          status: "NEW",
          rank: 0,
          rowVersion: 1,
          descriptionText: "TypeScript API experience.",
          tailoringState: "AWAITING_REVIEW",
        })
        .run();
      handle.db
        .insert(candidateProfiles)
        .values({ id: "local", name: "default", displayName: "Primary Profile", isDefault: true })
        .run();
      // Real imported + activated version: the revision route runs the
      // full generation preflight, which needs an active master whose
      // payload snapshots cleanly.
      const imported = importCandidate(handle, {
        document: JSON.parse(
          readFileSync(join(process.cwd(), "tests", "fixtures", "v1.2", "pm-profile.json"), "utf8"),
        ),
        actor: "human",
        profileId: "local",
      });
      if (!imported.ok) {
        throw new Error(`route seed failed: ${JSON.stringify(imported)}`);
      }
      const activated = activateProfileVersion(handle, {
        versionId: imported.versionId,
        actor: "human",
      });
      if (!activated.ok) {
        throw new Error(`route seed failed: ${JSON.stringify(activated)}`);
      }
      const profileVersionId = imported.versionId;
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
      const requestId = newId();
      const queueItemId = newId();
      const queueAttemptId = newId();
      const requestIdentity = `genreq:v1:${requestId}`;
      handle.db
        .insert(workItems)
        .values({
          id: queueItemId,
          kind: "TAILOR",
          idempotencyKey: requestIdentity,
          jobId,
          payloadJson: JSON.stringify({ schemaVersion: "tailor-queue/v2" }),
          state: "SUCCEEDED",
          attemptCount: 1,
          maxAttempts: 3,
        })
        .run();
      handle.db
        .insert(generationRequests)
        .values({
          id: requestId,
          requestIdentity,
          jobId,
          extractionId,
          profileId: "local",
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
          candidateSnapshotId,
          generationRequestId: requestId,
          workAttemptId: queueAttemptId,
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
          generationRequestId: requestId,
          workAttemptId: queueAttemptId,
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

  function seedCoachedVersion(input: {
    selectedKeywords: string[];
    directivesText: string | null;
    corruptAnalysis: boolean;
    linkRequest: boolean;
  }): string {
    // Snapshots and analyses are immutable: the E coaching world is a
    // second request/analysis/version chain reusing the base world's
    // extraction and candidate snapshot rows.
    const { jobId } = seedReviewable();
    const versionId = newId();
    const jdText =
      "Own product strategy and roadmap prioritization. Scale B2B SaaS onboarding. Grow ARR to $50M. Kubernetes experience preferred.";
    withDb((handle) => {
      const extraction = handle.db
        .select({ id: jobExtractions.id })
        .from(jobExtractions)
        .where(eq(jobExtractions.jobId, jobId))
        .get();
      const snapshot = handle.db
        .select({ id: candidateSnapshots.id })
        .from(candidateSnapshots)
        .all()[0];
      const attempt = handle.db.select({ id: workAttempts.id }).from(workAttempts).all()[0];
      if (extraction === undefined || snapshot === undefined || attempt === undefined) {
        throw new Error("seedReviewable chain incomplete");
      }
      const jdSnapshotId = newId();
      handle.db
        .insert(jdSnapshots)
        .values({
          id: jdSnapshotId,
          jobId,
          extractionId: extraction.id,
          jdText,
          canonicalSha256: "e".repeat(64),
        })
        .run();
      const workItemId = newId();
      handle.db
        .insert(workItems)
        .values({
          id: workItemId,
          kind: "TAILOR",
          idempotencyKey: `genreq:v1:${newId()}`,
          jobId,
          payloadJson: JSON.stringify({ schemaVersion: "tailor-queue/v2" }),
          state: "SUCCEEDED",
          attemptCount: 1,
          maxAttempts: 3,
        })
        .run();
      const requestId = newId();
      handle.db
        .insert(generationRequests)
        .values({
          id: requestId,
          requestIdentity: `genreq:v1:${requestId}`,
          jobId,
          extractionId: extraction.id,
          profileId: "local",
          profileVersionId: newId(),
          jdSnapshotId,
          requestKind: "INITIAL",
          steeringSnapshotJson: "{}",
          selectedKeywordsJson: JSON.stringify(input.selectedKeywords),
          directivesText: input.directivesText,
          payloadHash: "0".repeat(64),
          status: "SUCCEEDED",
          workItemId,
        })
        .run();
      const analysisId = newId();
      handle.db
        .insert(jobAnalyses)
        .values({
          id: analysisId,
          jobId,
          jdSnapshotId,
          candidateSnapshotId: snapshot.id,
          generationRequestId: input.linkRequest ? requestId : null,
          workAttemptId: attempt.id,
          requirementsJson: input.corruptAnalysis
            ? "{broken"
            : JSON.stringify({
                schemaVersion: "analysis-requirements/v1",
                requirements: [
                  {
                    requirement_id: "req_001",
                    jd_quote: "Own product strategy and roadmap prioritization",
                    category: "skill",
                    importance: "required",
                    match_status: "matched",
                    evidence_fact_ids: ["fact-roadmap"],
                    evidence_quotes: [],
                    review_status: "confirmed",
                  },
                  {
                    requirement_id: "req_002",
                    jd_quote: "Scale B2B SaaS onboarding",
                    category: "skill",
                    importance: "preferred",
                    match_status: "partial",
                    evidence_fact_ids: ["fact-discovery"],
                    evidence_quotes: [],
                    review_status: "proposed",
                  },
                ],
              }),
          gapsJson: input.corruptAnalysis
            ? "{broken"
            : JSON.stringify({
                schemaVersion: "analysis-gaps/v1",
                gaps: [
                  {
                    requirement_id: "req_003",
                    jd_quote: "Grow ARR to $50M in year one",
                    category: "screening",
                    importance: "required",
                    match_status: "gap",
                  },
                  {
                    requirement_id: "directive-1",
                    jd_quote: "Grow ARR to $50M in year one.",
                    category: "directive",
                    importance: "required",
                    match_status: "unsupported",
                    explanation: "KPI token is not backed",
                  },
                ],
              }),
          promptVersion: "tailor-prompt/v1",
          proposalSchemaVersion: "resume-proposal/v1",
        })
        .run();
      handle.db
        .insert(resumeVersions)
        .values({
          id: versionId,
          jobId,
          version: 2,
          parentVersionId: null,
          analysisId,
          generationRequestId: requestId,
          workAttemptId: attempt.id,
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
            changeSummary: null,
            audit: null,
          }),
          contentHash: "c".repeat(64),
          reviewState: "AWAITING_REVIEW",
        })
        .run();
      if (!input.corruptAnalysis) {
        handle.db
          .insert(resumeClaims)
          .values({
            id: newId(),
            resumeVersionId: versionId,
            claimText: "Own product strategy for a B2B SaaS suite.",
            requirementRef: "req_001",
          })
          .run();
      }
    });
    return versionId;
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
    // The revision route runs the full generation preflight, which
    // needs a configured provider.
    const previousProvider = process.env["TAILOR_PROVIDER_ARGV"];
    process.env["TAILOR_PROVIDER_ARGV"] = JSON.stringify(["tailor-provider"]);
    try {
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
      expect(body["requestId"]).toBeTypeOf("string");
      expect(jobRow(seed.jobId)).toMatchObject({ status: "NEW", tailoringState: "REVISION_REQUESTED" });
    } finally {
      if (previousProvider === undefined) {
        delete process.env["TAILOR_PROVIDER_ARGV"];
      } else {
        process.env["TAILOR_PROVIDER_ARGV"] = previousProvider;
      }
    }

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

  it("declines through the route with no follow-up work", async () => {
    const seed = seedReviewable();
    const noNote = await decline(
      postRequest(`/api/jobs/${seed.jobId}/resume/decline`, {
        resumeVersionId: seed.versionId,
        observedRowVersion: 1,
      }),
      routeParams(seed.jobId),
    );
    expect(noNote.status).toBe(400);
    const response = await decline(
      postRequest(`/api/jobs/${seed.jobId}/resume/decline`, {
        resumeVersionId: seed.versionId,
        observedRowVersion: 1,
        note: "Wrong seniority throughout; unusable.",
      }),
      routeParams(seed.jobId),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body["reviewId"]).toBeTypeOf("string");
    expect(jobRow(seed.jobId)).toMatchObject({ status: "NEW", tailoringState: "DECLINED" });
    const queued = withDb((handle) =>
      handle.db.select().from(workItems).where(eq(workItems.jobId, seed.jobId)).all(),
    );
    expect(queued.filter((item) => item.state === "QUEUED")).toHaveLength(0);
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

  it("projects requested-emphasis coaching from the bound run (E)", async () => {
    const versionId = seedCoachedVersion({
      selectedKeywords: ["product strategy", "B2B SaaS", "ARR", "Kubernetes", "C2 clearance"],
      directivesText: "Emphasize platform wins.\nGrow ARR to $50M in year one.",
      corruptAnalysis: false,
      linkRequest: true,
    });
    const response = await review(getRequest(`/api/resumes/${versionId}/review`), routeParams(versionId));
    expect(response.status).toBe(200);
    const body = (await readJson(response)) as {
      coaching: {
        policyVersion: string;
        assessed: boolean;
        terms: Array<{ term: string; outcome: string; requirementIds: string[]; evidenceFactIds: string[] }>;
        directivesRecorded: boolean;
        directives: Array<{ index: number; outcome: string; explanation: string | null }>;
      } | null;
    };
    expect(body.coaching?.policyVersion).toBe("keyword-coaching/v1");
    expect(body.coaching?.assessed).toBe(true);
    expect(body.coaching?.terms.map((entry) => [entry.term, entry.outcome])).toEqual([
      ["product strategy", "used"],
      ["B2B SaaS", "omitted-by-budget"],
      ["ARR", "unsupported"],
      ["Kubernetes", "not-assessed"],
      ["C2 clearance", "not-applicable"],
    ]);
    expect(body.coaching?.terms[0]).toMatchObject({
      requirementIds: ["req_001"],
      evidenceFactIds: ["fact-roadmap"],
    });
    expect(body.coaching?.directivesRecorded).toBe(true);
    expect(body.coaching?.directives).toEqual([
      { index: 0, directive: "Emphasize platform wins.", outcome: "used", explanation: null },
      {
        index: 1,
        directive: "Grow ARR to $50M in year one.",
        outcome: "unsupported",
        explanation: "KPI token is not backed",
      },
    ]);
  });

  it("degrades coaching to not-assessed on unreadable run data (E)", async () => {
    const versionId = seedCoachedVersion({
      selectedKeywords: ["product strategy"],
      directivesText: "Emphasize platform wins.",
      corruptAnalysis: true,
      linkRequest: true,
    });
    const response = await review(getRequest(`/api/resumes/${versionId}/review`), routeParams(versionId));
    expect(response.status).toBe(200);
    const body = (await readJson(response)) as {
      coaching: { assessed: boolean; terms: Array<{ outcome: string }>; directivesRecorded: boolean } | null;
    };
    expect(body.coaching?.assessed).toBe(false);
    expect(body.coaching?.terms.map((entry) => entry.outcome)).toEqual(["not-assessed"]);
    expect(body.coaching?.directivesRecorded).toBe(true);
  });

  it("projects the exact recorded guidance per version (F1/F7)", async () => {
    const seed = seedReviewable();
    const guided = withDb((handle) => {
      const profileVersion = handle.db
        .select({ id: candidateProfileVersions.id, version: candidateProfileVersions.version })
        .from(candidateProfileVersions)
        .where(eq(candidateProfileVersions.profileId, "local"))
        .get();
      const snapshot = handle.db
        .select({ id: candidateSnapshots.id })
        .from(candidateSnapshots)
        .all()[0];
      const attempt = handle.db.select({ id: workAttempts.id }).from(workAttempts).all()[0];
      const extraction = handle.db
        .select({ id: jobExtractions.id })
        .from(jobExtractions)
        .where(eq(jobExtractions.jobId, seed.jobId))
        .get();
      if (
        profileVersion === undefined ||
        snapshot === undefined ||
        attempt === undefined ||
        extraction === undefined
      ) {
        throw new Error("seedReviewable chain incomplete");
      }
      const steering = SteeringSnapshotV1.parse({
        schemaVersion: "generation-steering/v1",
        profileId: "local",
        profileVersionId: profileVersion.id,
        profileName: "default",
        profileDisplayName: "Primary Profile",
        executiveNarrative: null,
        targetTitles: [],
        targetLocations: [],
        careerKeywords: [],
        workMode: [],
        workAuthorization: [],
        sponsorshipRequired: null,
        willingToRelocate: null,
        yearsOfExperience: null,
      });
      const requestId = newId();
      const itemId = newId();
      const jdSnapshotId = newId();
      handle.db
        .insert(jdSnapshots)
        .values({
          id: jdSnapshotId,
          jobId: seed.jobId,
          extractionId: extraction.id,
          jdText: "TypeScript API experience.",
          canonicalSha256: "3".repeat(64),
        })
        .run();
      handle.db
        .insert(workItems)
        .values({
          id: itemId,
          kind: "TAILOR",
          idempotencyKey: `genreq:v1:${requestId}`,
          jobId: seed.jobId,
          payloadJson: JSON.stringify({ schemaVersion: "tailor-queue/v2" }),
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
          jobId: seed.jobId,
          extractionId: extraction.id,
          profileId: "local",
          profileVersionId: profileVersion.id,
          jdSnapshotId,
          requestKind: "REVISION",
          parentVersionId: seed.versionId,
          steeringSnapshotJson: JSON.stringify(steering),
          selectedKeywordsJson: JSON.stringify(["B2B SaaS", "product strategy"]),
          directivesText: "Emphasize discovery wins.",
          revisionNote: "Summary buries the lead.",
          payloadHash: "0".repeat(64),
          status: "SUCCEEDED",
          workItemId: itemId,
        })
        .run();
      const analysisId = newId();
      handle.db
        .insert(jobAnalyses)
        .values({
          id: analysisId,
          jobId: seed.jobId,
          jdSnapshotId,
          candidateSnapshotId: snapshot.id,
          generationRequestId: requestId,
          workAttemptId: attempt.id,
          requirementsJson: JSON.stringify({ schemaVersion: "analysis-requirements/v1", requirements: [] }),
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
          jobId: seed.jobId,
          version: 2,
          parentVersionId: seed.versionId,
          analysisId,
          generationRequestId: requestId,
          workAttemptId: attempt.id,
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
            changeSummary: null,
            audit: null,
          }),
          contentHash: "d".repeat(64),
          reviewState: "AWAITING_REVIEW",
        })
        .run();
      return { versionId, profileVersionId: profileVersion.id };
    });
    const response = await review(
      getRequest(`/api/resumes/${guided.versionId}/review`),
      routeParams(guided.versionId),
    );
    expect(response.status).toBe(200);
    const body = (await readJson(response)) as {
      guidance: {
        profileId: string;
        profileVersionId: string;
        profileVersionNumber: number | null;
        profileDisplayName: string | null;
        selectedKeywords: string[];
        directives: string | null;
        revisionNote: string | null;
      } | null;
    };
    expect(body.guidance).toEqual({
      profileId: "local",
      profileVersionId: guided.profileVersionId,
      profileVersionNumber: 1,
      profileDisplayName: "Primary Profile",
      selectedKeywords: ["B2B SaaS", "product strategy"],
      directives: "Emphasize discovery wins.",
      revisionNote: "Summary buries the lead.",
    });
  });

  it("degrades unreadable steering without failing the review (F7)", async () => {
    // The base seed stores steering "{}": the view reports a null
    // display name and empty keywords instead of 500ing or inventing.
    const seed = seedReviewable();
    const response = await review(
      getRequest(`/api/resumes/${seed.versionId}/review`),
      routeParams(seed.versionId),
    );
    expect(response.status).toBe(200);
    const body = (await readJson(response)) as {
      guidance: {
        profileId: string;
        profileVersionId: string | null;
        profileVersionNumber: number | null;
        profileDisplayName: string | null;
        selectedKeywords: string[];
        directives: string | null;
        revisionNote: string | null;
      } | null;
    };
    expect(body.guidance).not.toBeNull();
    expect(body.guidance).toMatchObject({
      profileId: "local",
      profileVersionNumber: 1,
      profileDisplayName: null,
      selectedKeywords: [],
      directives: null,
      revisionNote: null,
    });
    expect(typeof body.guidance?.profileVersionId).toBe("string");
  });

  it("reports unrecorded directives when the request stored none (E)", async () => {
    const versionId = seedCoachedVersion({
      selectedKeywords: ["product strategy"],
      directivesText: null,
      corruptAnalysis: false,
      linkRequest: true,
    });
    const response = await review(getRequest(`/api/resumes/${versionId}/review`), routeParams(versionId));
    expect(response.status).toBe(200);
    const body = (await readJson(response)) as {
      coaching: { directivesRecorded: boolean; directives: unknown[] } | null;
    };
    expect(body.coaching?.directivesRecorded).toBe(false);
    expect(body.coaching?.directives).toEqual([]);
  });
});
