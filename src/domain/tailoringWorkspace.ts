import { z } from "zod";
import { EntityId as Id, IsoUtcDateTime as Time, Sha256Hex as Hash } from "./fields";

/**
 * v1.3 tailoring-workspace contracts (`docs/tailoring-contracts-v1.3.md`
 * §3–§5, WO-1.3-A). Pure Zod schemas plus the semantic refinements the
 * contract requires: uniqueness, numerator bounds, byte-range order,
 * profile/version pairing, and request-kind/parent/note combinations.
 *
 * Database ownership (same-job FKs, active bindings, approved evidence)
 * stays service-side — these schemas prove shape only. Hash bytes live
 * in `src/tailoring/requestsV3.ts` (domain modules cannot import
 * `node:crypto`).
 */

export const TAILORING_FOCUS_SCHEMA_VERSION = "tailoring-focus/v1";
export const TAILORING_RECOMMENDATIONS_SCHEMA_VERSION = "tailoring-recommendations/v1";
export const RECOMMENDATIONS_POLICY_VERSION = "recommendations/1";
export const TAILORING_WORKSPACE_SCHEMA_VERSION = "tailoring-workspace/v1";
export const TAILORING_SUBMIT_SCHEMA_VERSION = "tailoring-submit/v1";
export const TAILORING_RETRY_SCHEMA_VERSION = "tailoring-retry/v1";
export const TAILORING_FAILURE_SCHEMA_VERSION = "tailoring-failure/v1";
export const WORKFLOW_REVIEW_SCHEMA_VERSION = "workflow-review/v1";
export const RESUME_ASSESSMENT_SCHEMA_VERSION = "resume-assessment/v1";
export const ASSESSMENT_POLICY_VERSION = "assessment/1";

/** Non-UUID keys: legacy profile ids, fact ids, role ids (≤128 chars). */
export const WorkspaceKey = z.string().min(1).max(128);
export type WorkspaceKey = z.infer<typeof WorkspaceKey>;

/** Human-authored notes: non-blank after trimming, ≤4000 chars. */
export const WorkspaceNote = z.string().trim().min(1).max(4000);
export type WorkspaceNote = z.infer<typeof WorkspaceNote>;

const Key = WorkspaceKey;
const Note = WorkspaceNote;

function unique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

export const FocusMappingV1 = z
  .object({
    roleId: Key,
    phraseId: Hash,
    factIds: z.array(Key).min(1).max(20),
  })
  .strict();
export type FocusMappingV1 = z.infer<typeof FocusMappingV1>;

export const FocusV1 = z
  .object({
    schemaVersion: z.literal(TAILORING_FOCUS_SCHEMA_VERSION),
    selectedPhraseIds: z.array(Hash).max(20),
    themeId: Key.nullable(),
    summaryDirection: z.string().max(4000),
    mappings: z.array(FocusMappingV1).max(100),
    additionalGuidance: z.string().max(1000),
  })
  .strict()
  .superRefine((focus, ctx) => {
    if (!unique(focus.selectedPhraseIds)) {
      ctx.addIssue({
        code: "custom",
        path: ["selectedPhraseIds"],
        message: "selectedPhraseIds must be unique",
      });
    }
    const pairs = focus.mappings.map((mapping) => JSON.stringify([mapping.roleId, mapping.phraseId]));
    if (!unique(pairs)) {
      ctx.addIssue({
        code: "custom",
        path: ["mappings"],
        message: "mappings must hold unique (roleId, phraseId) pairs",
      });
    }
  });
export type FocusV1 = z.infer<typeof FocusV1>;

export const RecommendationPhraseV1 = z
  .object({
    id: Hash,
    text: z.string().min(1).max(512),
    startByte: z.int().nonnegative(),
    endByte: z.int().positive(),
    excerpt: z.string().max(1024),
    count: z.int().positive(),
    category: z.string().max(80),
    support: z.enum(["supported", "uncertain", "gap"]),
    factIds: z.array(Key).max(100),
  })
  .strict()
  .superRefine((phrase, ctx) => {
    if (phrase.endByte <= phrase.startByte) {
      ctx.addIssue({
        code: "custom",
        path: ["endByte"],
        message: "endByte must be greater than startByte",
      });
    }
  });
export type RecommendationPhraseV1 = z.infer<typeof RecommendationPhraseV1>;

export const RecommendationRoleV1 = z
  .object({
    id: Key,
    label: z.string().max(200),
    factIds: z.array(Key).max(100),
  })
  .strict();
export type RecommendationRoleV1 = z.infer<typeof RecommendationRoleV1>;

export const RecommendationThemeV1 = z
  .object({
    id: Key,
    title: z.string().max(80),
    factIds: z.array(Key).max(100),
    summaryDirection: z.string().max(4000),
  })
  .strict();
export type RecommendationThemeV1 = z.infer<typeof RecommendationThemeV1>;

export const RecommendationV1 = z
  .object({
    schemaVersion: z.literal(TAILORING_RECOMMENDATIONS_SCHEMA_VERSION),
    policyVersion: z.literal(RECOMMENDATIONS_POLICY_VERSION),
    extractionId: Id,
    jdHash: Hash,
    profileVersionId: Id,
    profileHash: Hash,
    phrases: z.array(RecommendationPhraseV1).max(100),
    roles: z.array(RecommendationRoleV1).max(100),
    themes: z.array(RecommendationThemeV1).max(10),
    preset: FocusV1,
  })
  .strict()
  .superRefine((recommendations, ctx) => {
    if (!unique(recommendations.phrases.map((phrase) => phrase.id))) {
      ctx.addIssue({
        code: "custom",
        path: ["phrases"],
        message: "phrase ids must be unique",
      });
    }
    if (!unique(recommendations.roles.map((role) => role.id))) {
      ctx.addIssue({
        code: "custom",
        path: ["roles"],
        message: "role ids must be unique",
      });
    }
    if (!unique(recommendations.themes.map((theme) => theme.id))) {
      ctx.addIssue({
        code: "custom",
        path: ["themes"],
        message: "theme ids must be unique",
      });
    }
  });
export type RecommendationV1 = z.infer<typeof RecommendationV1>;

export const GENERATION_REQUEST_KINDS_V13 = ["INITIAL", "NEW_VERSION", "REVISION"] as const;
export type GenerationRequestKindV13 = (typeof GENERATION_REQUEST_KINDS_V13)[number];

export const WorkspacePut = z
  .object({
    schemaVersion: z.literal(TAILORING_WORKSPACE_SCHEMA_VERSION),
    extractionId: Id.nullable(),
    profileId: Key.nullable(),
    profileVersionId: Id.nullable(),
    requestKind: z.enum(GENERATION_REQUEST_KINDS_V13),
    parentVersionId: Id.nullable(),
    revisionNote: Note.nullable(),
    recommendationHash: Hash.nullable(),
    focus: FocusV1,
  })
  .strict()
  .superRefine((draft, ctx) => {
    if ((draft.profileId === null) !== (draft.profileVersionId === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["profileVersionId"],
        message: "profileId and profileVersionId must both be null or both be set",
      });
    }
    const kindOk =
      (draft.requestKind === "INITIAL" &&
        draft.parentVersionId === null &&
        draft.revisionNote === null) ||
      (draft.requestKind === "NEW_VERSION" &&
        draft.parentVersionId !== null &&
        draft.revisionNote === null) ||
      (draft.requestKind === "REVISION" &&
        draft.parentVersionId !== null &&
        draft.revisionNote !== null);
    if (!kindOk) {
      ctx.addIssue({
        code: "custom",
        path: ["requestKind"],
        message:
          "INITIAL has no parent/note; NEW_VERSION has a parent and no note; REVISION has a parent and a non-blank note",
      });
    }
  });
export type WorkspacePut = z.infer<typeof WorkspacePut>;

export const GenerateBody = z
  .object({
    schemaVersion: z.literal(TAILORING_SUBMIT_SCHEMA_VERSION),
    requestId: Id,
    workspaceRevision: z.int().positive(),
    observedRowVersion: z.int().positive(),
  })
  .strict();
export type GenerateBody = z.infer<typeof GenerateBody>;

export const RetryBody = z
  .object({
    schemaVersion: z.literal(TAILORING_RETRY_SCHEMA_VERSION),
    observedAttemptId: Id,
    observedRowVersion: z.int().positive(),
  })
  .strict();
export type RetryBody = z.infer<typeof RetryBody>;

/**
 * Public review bodies stay versionless: existing review routes retain
 * their envelopes while clients migrate (contracts §4). The job id rides
 * the URL path and the actor stays server-side (`human`).
 */
export const DecideBody = z
  .object({
    resumeVersionId: Id,
    observedRowVersion: z.int().positive(),
    note: z.string().trim().max(4000).optional(),
  })
  .strict();
export type DecideBody = z.infer<typeof DecideBody>;

export const DeclineBody = DecideBody.extend({ note: Note }).strict();
export type DeclineBody = z.infer<typeof DeclineBody>;

export const WorkspaceView = z
  .object({
    jobId: Id,
    revision: z.int().positive(),
    draft: WorkspacePut,
    recommendations: RecommendationV1.nullable(),
    lastRequestId: Id.nullable(),
    lastSubmittedRevision: z.int().positive().nullable(),
    updatedAt: Time,
  })
  .strict();
export type WorkspaceView = z.infer<typeof WorkspaceView>;

export const WorkspaceReply = z
  .object({
    ok: z.literal(true),
    workspace: WorkspaceView.nullable(),
  })
  .strict();
export type WorkspaceReply = z.infer<typeof WorkspaceReply>;

export const RecommendationsReply = z
  .object({
    ok: z.literal(true),
    recommendations: RecommendationV1,
    recommendationHash: Hash,
  })
  .strict();
export type RecommendationsReply = z.infer<typeof RecommendationsReply>;

export const GenerationReply = z
  .object({
    ok: z.literal(true),
    requestId: Id,
    workItemId: Id,
    status: z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"]),
    replayed: z.boolean(),
    jobRowVersion: z.int().positive(),
    workspaceRevision: z.int().positive(),
  })
  .strict();
export type GenerationReply = z.infer<typeof GenerationReply>;

export const TailoringStage = z.enum([
  "PREPARING_INPUTS",
  "WAITING_FOR_PROVIDER",
  "VALIDATING_PROPOSAL",
  "RENDERING_ARTIFACTS",
  "PUBLISHING_RESULT",
]);
export type TailoringStage = z.infer<typeof TailoringStage>;

export const TailoringFailure = z
  .object({
    code: z.enum([
      "INPUT_STALE",
      "PROFILE_UNAVAILABLE",
      "CONFIGURATION",
      "AUTHENTICATION",
      "RATE_LIMIT",
      "NETWORK",
      "PROVIDER_TIMEOUT",
      "LOCAL_LAUNCH",
      "INVALID_RESPONSE",
      "CLAIM_VALIDATION",
      "RENDER_FAILED",
      "PUBLISH_FAILED",
      "LEASE_LOST",
      "INTERNAL",
    ]),
    stage: TailoringStage.nullable(),
    occurredAt: Time,
    action: z.enum(["edit_focus", "edit_profile", "open_settings", "retry", "wait"]),
    retryAfterSeconds: z.int().nonnegative().nullable(),
    launchSubcode: z.enum(["ENOENT", "EACCES", "OTHER"]).nullable(),
  })
  .strict();
export type TailoringFailure = z.infer<typeof TailoringFailure>;

export const ProgressReply = z
  .object({
    ok: z.literal(true),
    requestId: Id,
    state: z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"]),
    serverNow: Time,
    attemptId: Id.nullable(),
    startedAt: Time.nullable(),
    finishedAt: Time.nullable(),
    leaseExpiresAt: Time.nullable(),
    lastHeartbeatAt: Time.nullable(),
    events: z
      .array(
        z
          .object({
            seq: z.int().min(1).max(5),
            stage: TailoringStage,
            source: z.enum(["provider", "cached"]),
            recordedAt: Time,
          })
          .strict(),
      )
      .max(5),
    failure: TailoringFailure.nullable(),
    resumeVersionId: Id.nullable(),
    retryAllowed: z.boolean(),
  })
  .strict();
export type ProgressReply = z.infer<typeof ProgressReply>;

export const MeasureSide = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("assessed"),
      numerator: z.int().nonnegative(),
      denominator: z.int().positive(),
    })
    .strict(),
  z
    .object({
      status: z.literal("not_assessed"),
      reason: z.enum([
        "NO_ELIGIBLE_ITEMS",
        "BASELINE_UNAVAILABLE",
        "CHECK_NOT_APPLICABLE",
        "LEGACY_UNRECORDED",
      ]),
    })
    .strict(),
]);
export type MeasureSide = z.infer<typeof MeasureSide>;

export const ASSESSMENT_MEASURE_KEYS = [
  "selected_keywords",
  "supported_requirements",
  "document_checks",
  "evidence_integrity",
] as const;
export type AssessmentMeasureKey = (typeof ASSESSMENT_MEASURE_KEYS)[number];

export const AssessmentMeasureV1 = z
  .object({
    key: z.enum(ASSESSMENT_MEASURE_KEYS),
    original: MeasureSide,
    tailored: MeasureSide,
    itemIds: z.array(Key).max(1000),
  })
  .strict()
  .superRefine((measure, ctx) => {
    for (const side of ["original", "tailored"] as const) {
      const value = measure[side];
      if (
        value.status === "assessed" &&
        value.numerator > value.denominator
      ) {
        ctx.addIssue({
          code: "custom",
          path: [side, "numerator"],
          message: "numerator must not exceed denominator",
        });
      }
    }
  });
export type AssessmentMeasureV1 = z.infer<typeof AssessmentMeasureV1>;

export const AssessmentV1 = z
  .object({
    schemaVersion: z.literal(RESUME_ASSESSMENT_SCHEMA_VERSION),
    policyVersion: z.literal(ASSESSMENT_POLICY_VERSION),
    measures: z.array(AssessmentMeasureV1).length(4),
  })
  .strict()
  .superRefine((assessment, ctx) => {
    if (!unique(assessment.measures.map((measure) => measure.key))) {
      ctx.addIssue({
        code: "custom",
        path: ["measures"],
        message: "measure keys must be unique",
      });
    }
  });
export type AssessmentV1 = z.infer<typeof AssessmentV1>;

export const WorkflowReviewExtension = z
  .object({
    schemaVersion: z.literal(WORKFLOW_REVIEW_SCHEMA_VERSION),
    requestId: Id.nullable(),
    masterText: z.string().nullable(),
    masterTextHash: Hash.nullable(),
    tailoredText: z.string(),
    tailoredContentHash: Hash,
    focus: FocusV1.nullable(),
    assessment: AssessmentV1.nullable(),
    selectedApproved: z.boolean(),
    latestPublished: z.boolean(),
    allowedActions: z
      .object({
        approve: z.boolean(),
        revise: z.boolean(),
        decline: z.boolean(),
        newVersion: z.boolean(),
        reason: z.string().max(280).nullable(),
      })
      .strict(),
  })
  .strict();
export type WorkflowReviewExtension = z.infer<typeof WorkflowReviewExtension>;

export const TailoringErrorBody = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: z.enum([
          "INVALID_REQUEST",
          "FORBIDDEN",
          "NOT_FOUND",
          "PRECONDITION_REQUIRED",
          "WORKSPACE_CONFLICT",
          "JOB_CONFLICT",
          "INPUT_STALE",
          "GENERATION_BUSY",
          "IDEMPOTENCY_MISMATCH",
          "PROFILE_NOT_READY",
          "JD_NOT_READY",
          "PROVIDER_NOT_READY",
          "INVALID_SELECTION",
          "REVIEW_NOT_ALLOWED",
          "RETRY_NOT_ALLOWED",
          "ARTIFACT_INTEGRITY",
          "STORAGE_UNAVAILABLE",
          "PREPARATION_BUSY",
          "PLAN_STALE",
          "UNRESOLVED_EVIDENCE",
          "BUDGET_EXCEEDED",
        ]),
        message: z.string().max(280),
        field: z.string().max(128).optional(),
        currentWorkspaceRevision: z.int().nonnegative().optional(),
        currentRowVersion: z.int().positive().optional(),
        requestId: Id.optional(),
        action: z
          .enum([
            "reload",
            "edit_profile",
            "open_settings",
            "edit_focus",
            "wait",
            "retry",
            "inspect_artifacts",
          ])
          .nullable(),
      })
      .strict(),
  })
  .strict();
export type TailoringErrorBody = z.infer<typeof TailoringErrorBody>;

/**
 * Focus-against-recommendation validation (contracts §3.1). Pure:
 * proves IDs exist in the frozen recommendation snapshot, selected
 * phrases are supported with approved facts, theme/roles are known,
 * and mapping facts are owned by the mapped role. Services map a
 * non-empty issue list to 422 INVALID_SELECTION; binding freshness
 * (404 ownership vs 409 INPUT_STALE) stays service-side.
 */
export const FOCUS_SELECTION_ISSUE_CODES = [
  "SELECTION_WITHOUT_BINDING",
  "MAPPINGS_WITHOUT_BINDING",
  "THEME_WITHOUT_BINDING",
  "UNKNOWN_PHRASE",
  "INELIGIBLE_PHRASE",
  "PHRASE_TOO_LONG",
  "UNKNOWN_THEME",
  "UNKNOWN_ROLE",
  "UNKNOWN_MAPPING_PHRASE",
  "FOREIGN_FACT",
] as const;
export type FocusSelectionIssueCode = (typeof FOCUS_SELECTION_ISSUE_CODES)[number];

export interface FocusSelectionIssue {
  code: FocusSelectionIssueCode;
  /** Dotted field path within the focus payload (e.g. `mappings.0.factIds`). */
  field: string;
  detail: string;
}

/** Provider-selected terms are capped at 128 chars (§3.2); longer quotes stay mapping/inspector context. */
export const SELECTABLE_TERM_MAX_CHARS = 128;

export function validateFocusSelection(
  focus: FocusV1,
  recommendations: RecommendationV1 | null,
): FocusSelectionIssue[] {
  if (recommendations === null) {
    const issues: FocusSelectionIssue[] = [];
    if (focus.selectedPhraseIds.length > 0) {
      issues.push({
        code: "SELECTION_WITHOUT_BINDING",
        field: "selectedPhraseIds",
        detail: "selected phrases require a complete active binding and recommendation snapshot",
      });
    }
    if (focus.mappings.length > 0) {
      issues.push({
        code: "MAPPINGS_WITHOUT_BINDING",
        field: "mappings",
        detail: "phrase-role mappings require a complete active binding and recommendation snapshot",
      });
    }
    if (focus.themeId !== null) {
      issues.push({
        code: "THEME_WITHOUT_BINDING",
        field: "themeId",
        detail: "theme selection requires a complete active binding and recommendation snapshot",
      });
    }
    return issues;
  }
  const phrases = new Map(recommendations.phrases.map((phrase) => [phrase.id, phrase]));
  const roles = new Map(recommendations.roles.map((role) => [role.id, role]));
  const themes = new Set(recommendations.themes.map((theme) => theme.id));
  const issues: FocusSelectionIssue[] = [];
  focus.selectedPhraseIds.forEach((phraseId, index) => {
    const phrase = phrases.get(phraseId);
    if (phrase === undefined) {
      issues.push({
        code: "UNKNOWN_PHRASE",
        field: `selectedPhraseIds.${index}`,
        detail: "selected phrase is not in the bound recommendation snapshot",
      });
      return;
    }
    if (phrase.support !== "supported" || phrase.factIds.length === 0) {
      issues.push({
        code: "INELIGIBLE_PHRASE",
        field: `selectedPhraseIds.${index}`,
        detail: "only supported phrases with approved facts can be selected; uncertain/gap candidates stay inspectable",
      });
      return;
    }
    if (phrase.text.length > SELECTABLE_TERM_MAX_CHARS) {
      issues.push({
        code: "PHRASE_TOO_LONG",
        field: `selectedPhraseIds.${index}`,
        detail: `selected terms are capped at ${SELECTABLE_TERM_MAX_CHARS} characters; longer quotes stay mapping/inspector context`,
      });
    }
  });
  if (focus.themeId !== null && !themes.has(focus.themeId)) {
    issues.push({
      code: "UNKNOWN_THEME",
      field: "themeId",
      detail: "theme is not in the bound recommendation snapshot",
    });
  }
  focus.mappings.forEach((mapping, index) => {
    const role = roles.get(mapping.roleId);
    if (role === undefined) {
      issues.push({
        code: "UNKNOWN_ROLE",
        field: `mappings.${index}.roleId`,
        detail: "mapped role is not in the bound recommendation snapshot",
      });
    }
    if (!phrases.has(mapping.phraseId)) {
      issues.push({
        code: "UNKNOWN_MAPPING_PHRASE",
        field: `mappings.${index}.phraseId`,
        detail: "mapped phrase is not in the bound recommendation snapshot",
      });
    }
    if (role !== undefined) {
      const owned = new Set(role.factIds);
      mapping.factIds.forEach((factId, factIndex) => {
        if (!owned.has(factId)) {
          issues.push({
            code: "FOREIGN_FACT",
            field: `mappings.${index}.factIds.${factIndex}`,
            detail: "mapping facts must be owned by the mapped role; generic experience cannot prove a missing tool/domain",
          });
        }
      });
    }
  });
  return issues;
}

/** Quoted strong ETag for workspace revisions: `"tw:{jobId}:{revision}"`. Missing workspaces use revision 0. */
export function buildWorkspaceETag(jobId: string, revision: number): string {
  return `"tw:${jobId}:${revision}"`;
}

export interface ParsedWorkspaceETag {
  jobId: string;
  revision: number;
}

/** Parse one `If-Match` value; wildcard, lists, and malformed tokens return null (400/428 stay service-side). */
export function parseWorkspaceETag(value: string): ParsedWorkspaceETag | null {
  const match = /^"tw:([^"]+):(\d+)"$/.exec(value.trim());
  if (match === null) {
    return null;
  }
  const jobId = match[1];
  const revision = Number(match[2]);
  if (Id.safeParse(jobId).success === false || Number.isInteger(revision) === false) {
    return null;
  }
  return { jobId, revision };
}

/**
 * v1.3 transaction ownership (contracts §4.1, work-orders §3). Each
 * transaction has exactly one owning order; the registry is the
 * executable A2 binding between transactions, intended services, and
 * the ADRs that govern their semantics.
 */
export const V13_TRANSACTION_KEYS = ["W", "G", "R", "A", "D"] as const;
export type V13TransactionKey = (typeof V13_TRANSACTION_KEYS)[number];

export interface V13TransactionBinding {
  key: V13TransactionKey;
  /** Short name used in contracts and acceptance prose. */
  name: "save" | "generate" | "retry" | "approve" | "decline";
  /** Owning work order; only this order implements the transaction. */
  owner: string;
  /** Intended service home (created or extended by the owner). */
  service: string;
  /** Governing ADRs; the owner must satisfy every listed decision. */
  adrs: readonly string[];
  /** Public request schema; review bodies are versionless by §4. */
  requestSchema: string;
}

export const V13_TRANSACTION_BINDINGS: Record<V13TransactionKey, V13TransactionBinding> = {
  W: {
    key: "W",
    name: "save",
    owner: "WO-1.3-B",
    service: "src/server/tailoringWorkspace.ts (new; repositories in src/db/tailoringWorkspace.ts)",
    adrs: ["R-ADR-017", "R-ADR-021", "R-ADR-022"],
    requestSchema: "tailoring-workspace/v1",
  },
  G: {
    key: "G",
    name: "generate",
    owner: "WO-1.3-E",
    service: "src/server/tailoring.ts requestGeneration/requestRevision (refactor; no default-profile fallback)",
    adrs: ["R-ADR-015", "R-ADR-017", "R-ADR-021", "R-ADR-022"],
    requestSchema: "tailoring-submit/v1",
  },
  R: {
    key: "R",
    name: "retry",
    owner: "WO-1.3-F",
    service: "src/queue/leases.ts requeueWorkItem via a new retry service (same immutable input)",
    adrs: ["R-ADR-015", "R-ADR-017", "R-ADR-023"],
    requestSchema: "tailoring-retry/v1",
  },
  A: {
    key: "A",
    name: "approve",
    owner: "WO-1.3-G",
    service: "src/server/review.ts approveResume (extend to eligible older awaiting versions)",
    adrs: ["R-ADR-006", "R-ADR-015", "R-ADR-018", "R-ADR-024"],
    requestSchema: "(versionless review body)",
  },
  D: {
    key: "D",
    name: "decline",
    owner: "WO-1.3-G",
    service: "src/server/review.ts declineVersion (terminal; queues nothing)",
    adrs: ["R-ADR-019", "R-ADR-024"],
    requestSchema: "(versionless review body)",
  },
};

/** Production full-page route (contracts §1/§5); the legacy drawer stays until H proves parity. */
export const PRODUCTION_TAILOR_ROUTE_PATTERN = "/jobs/[id]/tailor";
/** UI-only interaction reference; production must never import its fixtures. */
export const MOCKUP_REFERENCE_ROUTE = "/mockup";
