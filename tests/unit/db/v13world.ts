// @vitest-environment node
import { eq } from "drizzle-orm";
import {
  candidateSnapshots,
  createTestDatabase,
  generationRequests,
  jobAnalyses,
  jobExtractions,
  jobs,
  newId,
  resumeVersions,
  scrapeAttempts,
  workItems,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import { getOrCreateJdSnapshot } from "../../../src/server/candidates";
import { claimNextWorkItem } from "../../../src/queue/leases";
import { canonicalJson, canonicalText } from "../../../src/domain/canonical";
import type {
  AssessmentV1,
  FocusV1,
  RecommendationV1,
} from "../../../src/domain/tailoringWorkspace";
import { sha256HexUtf8 } from "../../../src/tailoring/hash";
import {
  hashRecommendation,
  hashSubmission,
  hashWorkflowRequestInput,
  phraseIdFor,
  type WorkflowRequestInput,
} from "../../../src/tailoring/requestsV3";
import {
  insertAssessment,
  insertRequestInputs,
  type InsertAssessmentInput,
  type InsertRequestInputsInput,
} from "../../../src/db/tailoringWorkspace";
import type { WorkspaceRecommendationsProvider } from "../../../src/server/tailoringWorkspace";
import {
  PM_JD_TEXT,
  seedCrossProfileWorld,
  type CrossProfileWorld,
} from "../acceptance-v1.2/world";

/**
 * v1.3 acceptance-test world (WO-1.3-B). Layers tailoring-workspace
 * fixtures on the v1.2 cross-profile world: a fresh READY job with
 * an extracted JD, reuse of the world's approved PM profile chain,
 * and builders for running TAILOR work, frozen request inputs,
 * published versions, and assessments. Recommendation fixtures are
 * deterministic over (extraction, profile version); the stub
 * provider below stands in for D's adapter.
 */

export const V13_T0 = "2026-09-16T12:00:00.000Z";

/**
 * Canonical `job-extraction-v1` envelope JSON for one retained JD
 * (WO-1.3-D). D's adapter strict-parses this shape; the legacy `{}`
 * seeds elsewhere in this module predate the envelope reader and
 * intentionally still fail validation.
 */
export function v13ExtractionJson(
  descriptionText: string | null,
  overrides: Record<string, unknown> = {},
): string {
  return canonicalJson({
    schemaVersion: "job-extraction-v1",
    fields: {
      title: "Product Manager",
      company: "Harbor Analytics",
      location: "Remote",
      arrangement: "REMOTE",
      salaryText: null,
      salaryCurrency: null,
      salaryMinMinor: null,
      salaryMaxMinor: null,
      descriptionText,
      postedAt: null,
      applyUrl: "https://example.com/jobs/apply",
      ...(overrides.fields as Record<string, unknown> | undefined),
    },
    provenance: {},
    adapterId: "generic",
    adapterVersion: "v1",
    confidence: 1,
    missingFields: [],
    contentHash: "0".repeat(64),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "fields")),
  });
}

export function withV13Database(fn: (t: TestDatabase, world: CrossProfileWorld) => void): void {
  const t = createTestDatabase("job-tracker-v13-");
  try {
    fn(t, seedCrossProfileWorld(t));
  } finally {
    t.cleanup();
  }
}

export interface V13Basics {
  jobId: string;
  extractionId: string;
  profileId: string;
  profileVersionId: string;
  snapshotId: string;
  jdSnapshotId: string;
  jdHash: string;
  profileHash: string;
  jdText: string;
}

/** Fresh NEW/READY job with a SUCCEEDED extraction, bound to the world's PM chain. */
export function seedV13Basics(
  handle: DatabaseHandle,
  world: CrossProfileWorld,
  overrides: { jdText?: string; extractedJson?: string } = {},
): V13Basics {
  const jobId = newId();
  const extractionId = newId();
  const attemptId = newId();
  const jdText = overrides.jdText ?? PM_JD_TEXT;
  handle.db
    .insert(jobs)
    .values({
      id: jobId,
      status: "NEW",
      rowVersion: 1,
      title: "Product Manager",
      company: "Harbor Analytics",
      descriptionText: jdText,
      tailoringState: "READY",
    })
    .run();
  handle.db
    .insert(scrapeAttempts)
    .values({
      id: attemptId,
      jobId,
      canonicalUrl: `https://example.com/jobs/${jobId}`,
      startedAt: V13_T0,
      finishedAt: V13_T0,
      outcome: "SUCCEEDED",
    })
    .run();
  handle.db
    .insert(jobExtractions)
    .values({
      id: extractionId,
      jobId,
      scrapeAttemptId: attemptId,
      version: 1,
      schemaVersion: "job-extraction-v1",
      adapter: "generic",
      extractedJson: overrides.extractedJson ?? "{}",
    })
    .run();
  handle.db.update(jobs).set({ activeExtractionId: extractionId }).where(eq(jobs.id, jobId)).run();
  const jdSnapshot = getOrCreateJdSnapshot(handle, { jobId, extractionId, jdText });
  if (!jdSnapshot.ok) {
    throw new Error(`v13 JD snapshot failed: ${jdSnapshot.error}`);
  }
  const jdSnapshotId = jdSnapshot.snapshotId;
  const profileRow = handle.db
    .select()
    .from(candidateSnapshots)
    .where(eq(candidateSnapshots.id, world.pmSnapshotId))
    .get();
  if (profileRow === undefined) {
    throw new Error("v1.2 world seeds no PM snapshot");
  }
  return {
    jobId,
    extractionId,
    profileId: world.pmProfileId,
    profileVersionId: world.pmVersionId,
    snapshotId: world.pmSnapshotId,
    jdSnapshotId,
    jdHash: sha256HexUtf8(canonicalText(jdText)),
    profileHash: profileRow.sha256,
    jdText,
  };
}

export interface V13Run {
  requestId: string;
  workItemId: string;
  attemptId: string;
  leaseToken: string;
  inputHash: string;
  submitHash: string;
}

/** QUEUED v3 TAILOR item claimed into RUNNING, with a linked generation request. */
export function seedV13RunningRun(
  handle: DatabaseHandle,
  basics: V13Basics,
  overrides: {
    requestId?: string;
    now?: string;
    steeringSnapshotJson?: string;
    profileId?: string;
    profileVersionId?: string;
  } = {},
): V13Run {
  const now = overrides.now ?? V13_T0;
  const requestId = overrides.requestId ?? newId();
  const inputHash = "1".repeat(64);
  const submitHash = hashSubmission({
    jobId: basics.jobId,
    requestId,
    workspaceRevision: 1,
    observedRowVersion: 1,
  });
  const workItemId = newId();
  handle.db
    .insert(workItems)
    .values({
      id: workItemId,
      kind: "TAILOR",
      jobId: basics.jobId,
      idempotencyKey: `v13-${requestId}`,
      payloadJson: JSON.stringify({
        schemaVersion: "tailor-queue/v3",
        generationRequestId: requestId,
        jobId: basics.jobId,
        extractionId: basics.extractionId,
        profileId: basics.profileId,
        profileVersionId: basics.profileVersionId,
        jdSnapshotId: basics.jdSnapshotId,
        payloadHash: "2".repeat(64),
        inputHash,
      }),
    })
    .run();
  const claimed = claimNextWorkItem(handle, {
    workerId: "worker-v13",
    kinds: ["TAILOR"],
    leaseDurationMs: 300_000,
    now,
  });
  if (claimed === null || claimed.id !== workItemId) {
    throw new Error("v13 run claim failed");
  }
  // The claim inserts the RUNNING work_attempts row itself; the fence
  // trigger reads it from there.
  handle.db
    .insert(generationRequests)
    .values({
      id: requestId,
      requestIdentity: `genreq:v1:${requestId}`,
      jobId: basics.jobId,
      extractionId: basics.extractionId,
      profileId: overrides.profileId ?? basics.profileId,
      profileVersionId: overrides.profileVersionId ?? basics.profileVersionId,
      jdSnapshotId: basics.jdSnapshotId,
      requestKind: "INITIAL",
      steeringSnapshotJson:
        overrides.steeringSnapshotJson ??
        JSON.stringify({
          schemaVersion: "generation-steering/v1",
          profileId: basics.profileId,
          profileVersionId: basics.profileVersionId,
          profileName: "pm",
          profileDisplayName: "PM Profile",
          executiveNarrative: null,
          targetTitles: [],
          targetLocations: [],
          careerKeywords: [],
          workMode: [],
          workAuthorization: [],
          sponsorshipRequired: null,
          willingToRelocate: null,
          yearsOfExperience: null,
        }),
      selectedKeywordsJson: JSON.stringify([]),
      payloadHash: "2".repeat(64),
      status: "RUNNING",
      workItemId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return {
    requestId,
    workItemId,
    attemptId: claimed.currentAttemptId,
    leaseToken: claimed.leaseToken,
    inputHash,
    submitHash,
  };
}

export function v13Focus(overrides: Partial<FocusV1> = {}): FocusV1 {
  return {
    schemaVersion: "tailoring-focus/v1",
    selectedPhraseIds: [],
    themeId: null,
    summaryDirection: "",
    mappings: [],
    additionalGuidance: "",
    ...overrides,
  };
}

export function v13Recommendations(
  basics: V13Basics,
  overrides: Partial<RecommendationV1> = {},
): RecommendationV1 {
  const phraseId = phraseIdFor({
    extractionId: basics.extractionId,
    jdHash: basics.jdHash,
    startByte: 0,
    endByte: 20,
    text: "supply chain roadmap",
  });
  return {
    schemaVersion: "tailoring-recommendations/v1",
    policyVersion: "recommendations/1",
    extractionId: basics.extractionId,
    jdHash: basics.jdHash,
    profileVersionId: basics.profileVersionId,
    profileHash: basics.profileHash,
    phrases: [
      {
        id: phraseId,
        text: "supply chain roadmap",
        startByte: 0,
        endByte: 20,
        excerpt: "…lead the supply chain roadmap…",
        count: 3,
        category: "product",
        support: "supported",
        factIds: ["fact-pm-1"],
      },
    ],
    roles: [{ id: "role-pm", label: "Lead PM", factIds: ["fact-pm-1"] }],
    themes: [
      {
        id: "theme-ops",
        title: "Operations",
        factIds: ["fact-pm-1"],
        summaryDirection: "Lead with ops.",
      },
    ],
    preset: v13Focus({ selectedPhraseIds: [phraseId], themeId: "theme-ops" }),
    ...overrides,
  };
}

export function v13Assessment(): AssessmentV1 {
  return {
    schemaVersion: "resume-assessment/v1",
    policyVersion: "assessment/1",
    measures: [
      {
        key: "selected_keywords",
        original: { status: "assessed", numerator: 2, denominator: 4 },
        tailored: { status: "assessed", numerator: 3, denominator: 4 },
        itemIds: ["a", "b", "c", "d"],
      },
      {
        key: "supported_requirements",
        original: { status: "not_assessed", reason: "BASELINE_UNAVAILABLE" },
        tailored: { status: "assessed", numerator: 3, denominator: 5 },
        itemIds: ["r1", "r2", "r3", "r4", "r5"],
      },
      {
        key: "document_checks",
        original: { status: "not_assessed", reason: "BASELINE_UNAVAILABLE" },
        tailored: { status: "assessed", numerator: 4, denominator: 4 },
        itemIds: ["c1", "c2", "c3", "c4"],
      },
      {
        key: "evidence_integrity",
        original: { status: "not_assessed", reason: "CHECK_NOT_APPLICABLE" },
        tailored: { status: "assessed", numerator: 9, denominator: 9 },
        itemIds: ["k1"],
      },
    ],
  };
}

export const V13_MASTER_TEXT = "Avery Stone\nProduct leader.\n";

/** Frozen request-input row matching the run's workspace revision 1. */
export function seedV13RequestInputs(
  handle: DatabaseHandle,
  basics: V13Basics,
  run: V13Run,
  overrides: Partial<InsertRequestInputsInput> = {},
): { focus: FocusV1; recommendations: RecommendationV1; inputHash: string } {
  const focus = v13Focus();
  const recommendations = v13Recommendations(basics);
  const workflowInput: WorkflowRequestInput = {
    workspaceRevision: 1,
    focus,
    recommendations,
    candidateSnapshotId: basics.snapshotId,
    masterText: V13_MASTER_TEXT,
    masterTextHash: sha256HexUtf8(V13_MASTER_TEXT),
    projectionVersion: "master-text/1",
  };
  const inputHash = hashWorkflowRequestInput(workflowInput);
  insertRequestInputs(handle, {
    requestId: run.requestId,
    workspaceRevision: 1,
    submitHash: run.submitHash,
    inputHash,
    candidateSnapshotId: basics.snapshotId,
    focusJson: canonicalJson(focus),
    recommendationsJson: canonicalJson(recommendations),
    masterText: V13_MASTER_TEXT,
    masterTextHash: sha256HexUtf8(V13_MASTER_TEXT),
    projectionVersion: "master-text/1",
    now: V13_T0,
    ...overrides,
  });
  return { focus, recommendations, inputHash };
}

export interface V13Version {
  versionId: string;
  analysisId: string;
  contentHash: string;
}

/** Published v1 for the run: analysis + version with durable request/snapshot linkage. */
export function seedV13Version(
  handle: DatabaseHandle,
  basics: V13Basics,
  run: V13Run,
  overrides: { version?: number; reviewState?: string; createdAt?: string; analysisId?: string } = {},
): V13Version {
  const versionId = newId();
  const contentHash = sha256HexUtf8(canonicalJson({ version: versionId }));
  const analysisId = overrides.analysisId ?? newId();
  if (overrides.analysisId === undefined) {
    handle.db
      .insert(jobAnalyses)
      .values({
        id: analysisId,
        jobId: basics.jobId,
        jdSnapshotId: basics.jdSnapshotId,
        candidateSnapshotId: basics.snapshotId,
        workAttemptId: run.attemptId,
        generationRequestId: run.requestId,
        requirementsJson: JSON.stringify([]),
        gapsJson: JSON.stringify([]),
        promptVersion: "tailor-prompt/v1",
        proposalSchemaVersion: "tailor-proposal/v1",
        createdAt: V13_T0,
      })
      .run();
  }
  handle.db
    .insert(resumeVersions)
    .values({
      id: versionId,
      jobId: basics.jobId,
      version: overrides.version ?? 1,
      analysisId,
      generationRequestId: run.requestId,
      workAttemptId: run.attemptId,
      templateId: "classic",
      templateVersion: "1",
      templateHash: "3".repeat(64),
      rankerVersion: "ranker/1",
      policyVersion: "policy/1",
      configVersion: "config/1",
      renderSchemaVersion: "render/1",
      contentJson: canonicalJson({ version: versionId }),
      contentHash,
      reviewState: overrides.reviewState ?? "AWAITING_REVIEW",
      createdAt: overrides.createdAt ?? V13_T0,
      updatedAt: overrides.createdAt ?? V13_T0,
    })
    .run();
  return { versionId, analysisId, contentHash };
}

export function seedV13Assessment(
  handle: DatabaseHandle,
  run: V13Run,
  version: V13Version,
  overrides: Partial<InsertAssessmentInput> = {},
): string {
  const measuresJson = canonicalJson(v13Assessment());
  insertAssessment(handle, {
    resumeVersionId: version.versionId,
    requestId: run.requestId,
    policyVersion: "assessment/1",
    masterTextHash: sha256HexUtf8(V13_MASTER_TEXT),
    tailoredContentHash: version.contentHash,
    measuresJson,
    now: V13_T0,
    ...overrides,
  });
  return measuresJson;
}

/** Stub recommendation provider for W tests (stands in for D's adapter). */
export function stubRecommendationsProvider(
  recommendations: RecommendationV1 | null,
  failure?: { error: "extraction-not-ready" | "storage-unavailable"; detail: string },
): WorkspaceRecommendationsProvider & { calls: number } {
  const stub = {
    calls: 0,
    getRecommendations() {
      stub.calls += 1;
      if (failure !== undefined) {
        return { ok: false as const, ...failure };
      }
      if (recommendations === null) {
        return {
          ok: false as const,
          error: "extraction-not-ready" as const,
          detail: "stub has no recommendations for this binding",
        };
      }
      return { ok: true as const, recommendations };
    },
  };
  return stub;
}

export function recommendationHashFor(basics: V13Basics): string {
  return hashRecommendation(v13Recommendations(basics));
}
