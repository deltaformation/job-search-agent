// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  createTestDatabase,
  generationRequests,
  jobExtractions,
  jobs,
  newId,
  scrapeAttempts,
  utcNow,
  workAttempts,
  workItems,
  type TestDatabase,
} from "../../../src/db";
import { createProfile } from "../../../src/db/candidates";
import {
  insertAnalysis,
  insertResumeArtifact,
  insertResumeClaim,
  insertResumeClaimFact,
  insertResumeVersion,
} from "../../../src/db/tailoring";
import { canonicalJson } from "../../../src/domain/canonical";
import {
  activateProfileVersion,
  getOrCreateCandidateSnapshot,
  getOrCreateJdSnapshot,
  importCandidate,
} from "../../../src/server/candidates";
import { sha256HexUtf8 } from "../../../src/tailoring/hash";
import {
  canonicalKeywordSet,
  generationRequestIdentity,
  hashGenerationRequest,
  SteeringSnapshotV1,
  TAILOR_QUEUE_SCHEMA_VERSION_V2,
  TailorQueuePayloadV2,
} from "../../../src/tailoring/requests";

/**
 * Shared v1.2 acceptance world (WO-1.2-A correction pass).
 *
 * Seeds a preflight-valid PM-v1 setup through real services: two
 * imported + activated profiles with approved facts, a job carrying
 * the PM JD fixture, snapshots, one SUCCEEDED explicit generation
 * request (v1: PM profile + guidance) with its linked queue item,
 * attempt, analysis, and a real parent resume version with one
 * evidence-backed claim. Every spec in this directory builds on this
 * world (or an explicitly documented subset), so guards and pins share
 * one setup path: if seeding breaks, the guards fail loudly instead of
 * letting a pin pass spuriously.
 */

const FIXTURE_ROOT = join(process.cwd(), "tests", "fixtures", "v1.2");

/** PM JD text (F5 reproduction). v1 guidance keywords must occur in it. */
export const PM_JD_TEXT: string = readFileSync(join(FIXTURE_ROOT, "jd", "pm-rich.txt"), "utf8");

/** Exact v1 guidance: profile PM + selections + directives. */
export const PM_GUIDANCE = {
  selectedKeywords: ["product strategy", "B2B SaaS"],
  directives: "Emphasize B2B SaaS discovery wins and roadmap ownership.",
} as const;

/** Exact v2 guidance: profile Senior PM + selections + directives. */
export const SPM_GUIDANCE = {
  selectedKeywords: ["B2B SaaS", "stakeholder management"],
  directives: "Emphasize platform scope and org leadership.",
} as const;

export interface CrossProfileWorld {
  pmProfileId: string;
  spmProfileId: string;
  pmVersionId: string;
  spmVersionId: string;
  pmSnapshotId: string;
  jdSnapshotId: string;
  jobId: string;
  extractionId: string;
  analysisId: string;
  v1Id: string;
  v1WorkItemId: string;
  v1RequestId: string;
  v1AttemptId: string;
  jdText: string;
}

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, name), "utf8")) as unknown;
}

function mustOk<T extends { ok: boolean }>(result: T, what: string): Extract<T, { ok: true }> {
  if (!result.ok) {
    throw new Error(`${what} failed: ${JSON.stringify(result)}`);
  }
  return result as Extract<T, { ok: true }>;
}

export function runWithWorld(fn: (t: TestDatabase, world: CrossProfileWorld) => void): void {
  const t = createTestDatabase("job-tracker-v12-world-");
  try {
    fn(t, seedCrossProfileWorld(t));
  } finally {
    t.cleanup();
  }
}

/**
 * Seed the full PM-v1 world. Throws on any seeding failure so a broken
 * setup can never masquerade as an expected failure: callers assert
 * preconditions in passing guards over this same world.
 */
export function seedCrossProfileWorld(t: TestDatabase): CrossProfileWorld {
  const { db } = t.handle;
  const now = utcNow();

  const pm = createProfile(t.handle, { name: "pm", displayName: "Product Manager" });
  const spm = createProfile(t.handle, { name: "spm", displayName: "Senior Product Manager" });

  const pmImport = mustOk(
    importCandidate(t.handle, {
      document: loadFixture("pm-profile.json"),
      actor: "human",
      profileId: pm.id,
    }),
    "pm import",
  );
  mustOk(activateProfileVersion(t.handle, { versionId: pmImport.versionId, actor: "human" }), "pm activate");
  const spmImport = mustOk(
    importCandidate(t.handle, {
      document: loadFixture("spm-profile.json"),
      actor: "human",
      profileId: spm.id,
    }),
    "spm import",
  );
  mustOk(
    activateProfileVersion(t.handle, { versionId: spmImport.versionId, actor: "human" }),
    "spm activate",
  );

  const pmSnapshot = mustOk(
    getOrCreateCandidateSnapshot(t.handle, { profileVersionId: pmImport.versionId }),
    "pm snapshot",
  );

  const jobId = newId();
  const extractionId = newId();
  const attemptId = newId();
  db.insert(jobs)
    .values({
      id: jobId,
      status: "NEW",
      rowVersion: 1,
      title: "Product Manager",
      company: "Harbor Analytics",
      descriptionText: PM_JD_TEXT,
      tailoringState: "AWAITING_REVIEW",
    })
    .run();
  db.insert(scrapeAttempts)
    .values({
      id: attemptId,
      jobId,
      canonicalUrl: "https://example.com/jobs/v12-pm",
      startedAt: now,
      finishedAt: now,
      outcome: "SUCCEEDED",
    })
    .run();
  db.insert(jobExtractions)
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
  db.update(jobs).set({ activeExtractionId: extractionId }).where(eq(jobs.id, jobId)).run();

  const jdSnapshot = mustOk(
    getOrCreateJdSnapshot(t.handle, { jobId, extractionId, jdText: PM_JD_TEXT }),
    "jd snapshot",
  );

  // The v1 explicit request: same frozen shape the command writes,
  // marked SUCCEEDED with linked queue item + attempt.
  const v1RequestId = newId();
  const v1Identity = generationRequestIdentity(v1RequestId);
  const v1Keywords = canonicalKeywordSet([...PM_GUIDANCE.selectedKeywords]);
  const v1Steering = SteeringSnapshotV1.parse({
    schemaVersion: "generation-steering/v1",
    profileId: pm.id,
    profileVersionId: pmImport.versionId,
    profileName: pm.name,
    profileDisplayName: pm.displayName,
    executiveNarrative: pm.executiveNarrative,
    targetTitles: pm.workPreferences?.targetTitles ?? [],
    targetLocations: pm.workPreferences?.targetLocations ?? [],
    careerKeywords: pm.workPreferences?.careerKeywords ?? [],
    workMode: pm.workPreferences?.workMode ?? [],
    workAuthorization: pm.workPreferences?.workAuthorization ?? [],
    sponsorshipRequired: pm.workPreferences?.sponsorshipRequired ?? null,
    willingToRelocate: pm.workPreferences?.willingToRelocate ?? null,
    yearsOfExperience: pm.workPreferences?.yearsOfExperience ?? null,
  });
  const v1PayloadHash = hashGenerationRequest({
    requestIdentity: v1Identity,
    jobId,
    extractionId,
    profileId: pm.id,
    profileVersionId: pmImport.versionId,
    jdSnapshotId: jdSnapshot.snapshotId,
    parentVersionId: null,
    requestKind: "INITIAL",
    steeringSnapshot: v1Steering,
    selectedKeywords: v1Keywords,
    directivesText: PM_GUIDANCE.directives,
    revisionNote: null,
  });
  const payload = TailorQueuePayloadV2.parse({
    schemaVersion: TAILOR_QUEUE_SCHEMA_VERSION_V2,
    generationRequestId: v1RequestId,
    jobId,
    extractionId,
    profileId: pm.id,
    profileVersionId: pmImport.versionId,
    jdSnapshotId: jdSnapshot.snapshotId,
    payloadHash: v1PayloadHash,
  });
  const workItemId = newId();
  const v1AttemptId = newId();
  db.insert(workItems)
    .values({
      id: workItemId,
      kind: "TAILOR",
      idempotencyKey: v1Identity,
      jobId,
      payloadJson: JSON.stringify(payload),
      state: "SUCCEEDED",
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(generationRequests)
    .values({
      id: v1RequestId,
      requestIdentity: v1Identity,
      jobId,
      extractionId,
      profileId: pm.id,
      profileVersionId: pmImport.versionId,
      jdSnapshotId: jdSnapshot.snapshotId,
      parentVersionId: null,
      requestKind: "INITIAL",
      steeringSnapshotJson: canonicalJson(v1Steering),
      selectedKeywordsJson: canonicalJson(v1Keywords),
      directivesText: PM_GUIDANCE.directives,
      revisionNote: null,
      payloadHash: v1PayloadHash,
      status: "SUCCEEDED",
      workItemId,
      startedAt: now,
      finishedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(workAttempts)
    .values({
      id: v1AttemptId,
      workItemId,
      attemptNumber: 1,
      workerId: "acceptance-seed",
      startedAt: now,
      finishedAt: now,
      result: "SUCCEEDED",
      createdAt: now,
    })
    .run();

  const requirementsDoc = {
    schemaVersion: "analysis-requirements/v1",
    requirements: [
      {
        requirement_id: "req-discovery",
        jd_quote: "customer discovery",
        category: "skill",
        importance: "required",
        match_status: "matched",
        evidence_fact_ids: ["pm-fact-discovery"],
        evidence_quotes: ["Led customer discovery with 40+ B2B SaaS buyers."],
        review_status: "confirmed",
      },
    ],
  };
  const gapsDoc = {
    schemaVersion: "analysis-gaps/v1",
    gaps: [
      {
        requirement_id: "gap-k8s",
        jd_quote: "Kubernetes cluster management",
        category: "skill",
        importance: "preferred",
        match_status: "gap",
      },
    ],
  };
  const analysis = insertAnalysis(t.handle, {
    jobId,
    jdSnapshotId: jdSnapshot.snapshotId,
    candidateSnapshotId: pmSnapshot.snapshotId,
    requirementsJson: JSON.stringify(requirementsDoc),
    gapsJson: JSON.stringify(gapsDoc),
    provider: "acceptance-seam",
    model: "acceptance-seam",
    promptVersion: "tailor-prompt/v1",
    proposalSchemaVersion: "resume-proposal/v1",
    inputHash: sha256HexUtf8(
      canonicalJson({
        jd: jdSnapshot.sha256,
        candidate: pmSnapshot.sha256,
        guidance: {
          p: pm.id,
          k: [...PM_GUIDANCE.selectedKeywords].sort(),
          d: PM_GUIDANCE.directives,
        },
      }),
    ),
    proposalHash: sha256HexUtf8(canonicalJson(requirementsDoc)),
    rationale: "Discovery requirement supported by pm-fact-discovery; Kubernetes is a gap.",
    attemptJson: null,
    generationRequestId: v1RequestId,
    workAttemptId: v1AttemptId,
  });

  const contentJson = "{}";
  const v1 = insertResumeVersion(t.handle, {
    jobId,
    version: 1,
    parentVersionId: null,
    analysisId: analysis.id,
    templateId: "standard",
    templateVersion: "v1",
    templateHash: "t".repeat(64),
    rankerVersion: "ranker-v1",
    policyVersion: "policy-v1",
    configVersion: "config-v1",
    renderSchemaVersion: "render-v1",
    contentJson,
    contentHash: sha256HexUtf8(contentJson),
    reviewState: "AWAITING_REVIEW",
    generationRequestId: v1RequestId,
    workAttemptId: v1AttemptId,
  });
  const claim = insertResumeClaim(t.handle, {
    resumeVersionId: v1.id,
    claimText: "Led customer discovery with 40+ B2B SaaS buyers.",
    requirementRef: "req-discovery",
    derivationKind: null,
    derivationPayload: null,
  });
  insertResumeClaimFact(t.handle, { claimId: claim.id, factId: "pm-fact-discovery" });
  // Stored artifact digests (records only — no bytes; revision and
  // decline bind these without touching disk).
  const artifactKinds = [
    { kind: "MARKDOWN", mediaType: "text/markdown", suffix: "md" },
    {
      kind: "DOCX",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      suffix: "docx",
    },
    { kind: "PDF", mediaType: "application/pdf", suffix: "pdf" },
  ] as const;
  for (const artifact of artifactKinds) {
    insertResumeArtifact(t.handle, {
      resumeVersionId: v1.id,
      kind: artifact.kind,
      relativePath: `v12-seed/${v1.id}/resume.${artifact.suffix}`,
      mediaType: artifact.mediaType,
      byteSize: 256,
      sha256: sha256HexUtf8(`v12-seed:${v1.id}:${artifact.kind}`),
    });
  }
  db.update(jobs)
    .set({ activeResumeVersionId: v1.id })
    .where(eq(jobs.id, jobId))
    .run();

  return {
    pmProfileId: pm.id,
    spmProfileId: spm.id,
    pmVersionId: pmImport.versionId,
    spmVersionId: spmImport.versionId,
    pmSnapshotId: pmSnapshot.snapshotId,
    jdSnapshotId: jdSnapshot.snapshotId,
    jobId,
    extractionId,
    analysisId: analysis.id,
    v1Id: v1.id,
    v1WorkItemId: workItemId,
    v1RequestId,
    v1AttemptId,
    jdText: PM_JD_TEXT,
  };
}
