import { z } from "zod";
import { StoredProfilePayload, type StoredProfilePayload as StoredProfilePayloadType } from "./candidate";
import { canonicalText } from "./canonical";
import { RecommendationV1 } from "./tailoringWorkspace";
import {
  EntityId as Id,
  IsoUtcDateTime as Time,
  Sha256Hex as Hash,
} from "./fields";

/**
 * WO-1.3-S2-A frozen Step 2 contracts: intake binding, preparation
 * queue, accepted plan, editor draft, validation verdicts, commands,
 * and provider planning envelopes.
 *
 * Pure domain module: Zod schemas plus deterministic id/hash/
 * transition/budget helpers. No database, worker, provider, or UI
 * code. Normative text lives in
 * `docs/contracts/v1.3-step2-contracts.md`; this module is its
 * executable pin. S2-B/S2-C/S2-D consume these exact schemas.
 */

export const STEP2_SCHEMA_VERSIONS = {
  intakeBinding: "step2-intake-binding/v1",
  prepareQueue: "prepare-queue/v1",
  plan: "step2-plan/v1",
  draft: "step2-draft/v1",
  validation: "step2-validation/v1",
  workspace: "tailoring-workspace/v2",
  prepareCommand: "step2-prepare/v1",
  prepareRetry: "step2-prepare-retry/v1",
  validateDraft: "step2-validate-draft/v1",
  preparationInput: "preparation-input/v1",
  preparationProposal: "preparation-proposal/v1",
} as const;

export const PREPARE_PROMPT_VERSION = "prepare-prompt/v1";
export const STEP2_CLAIMS_POLICY = "step2-claims/1";
export const STEP2_MASTER_PROJECTION = "step2-master-bullets/1";
export const STEP2_PLAN_VALIDATION_VERSION = "step2-plan-validation/v1";

/** New queue kind (planned `WorkKind` amendment; S2-B extends the enum). */
export const Step2WorkKind = z.literal("PREPARE");
export type Step2WorkKind = z.infer<typeof Step2WorkKind>;

/** New `ErrorBody` codes (planned extension; S2-B merges into the union). */
export const Step2ErrorCode = z.enum([
  "PREPARATION_BUSY",
  "PLAN_STALE",
  "UNRESOLVED_EVIDENCE",
  "BUDGET_EXCEEDED",
]);
export type Step2ErrorCode = z.infer<typeof Step2ErrorCode>;

const Key = z.string().min(1).max(128);

/* ------------------------------------------------------------------ */
/* 1.1 Intake binding                                                  */
/* ------------------------------------------------------------------ */

export const IntakeBindingV1 = z
  .object({
    schemaVersion: z.literal(STEP2_SCHEMA_VERSIONS.intakeBinding),
    intakeItemId: Id.nullable(),
    profileId: Key,
    profileVersionId: Id,
    profilePayloadHash: Hash,
    evidenceHash: Hash,
    masterSourceId: Id.nullable(),
    capturedAt: Time,
    batchId: Id.nullable(),
  })
  .strict();
export type IntakeBindingV1 = z.infer<typeof IntakeBindingV1>;

/* ------------------------------------------------------------------ */
/* 1.2 Queue payload                                                   */
/* ------------------------------------------------------------------ */

export const PreparePayloadV1 = z
  .object({
    schemaVersion: z.literal(STEP2_SCHEMA_VERSIONS.prepareQueue),
    preparationId: Id,
    jobId: Id,
    extractionId: Id,
    profileVersionId: Id,
    bindingHash: Hash,
  })
  .strict();
export type PreparePayloadV1 = z.infer<typeof PreparePayloadV1>;

export function prepareIdempotencyKey(
  jobId: string,
  preparationId: string,
  extractionId: string,
): string {
  return `prepare:${jobId}:${preparationId}:${extractionId}`;
}

/* ------------------------------------------------------------------ */
/* 1.3 Accepted plan                                                   */
/* ------------------------------------------------------------------ */

export const PreparationStage = z.enum([
  "LOADING_INPUTS",
  "WAITING_FOR_PROVIDER",
  "VALIDATING_PROPOSAL",
  "STORING_PLAN",
  "PUBLISHING_PLAN",
]);
export type PreparationStage = z.infer<typeof PreparationStage>;

export const PREPARATION_STAGE_ORDER: readonly PreparationStage[] =
  PreparationStage.options;

const PlanQuote = z
  .object({
    text: z.string().min(1).max(512),
    startByte: z.int().nonnegative(),
    endByte: z.int().positive(),
  })
  .strict();

export const PlanPriorityV1 = z
  .object({
    priorityId: Hash,
    quote: PlanQuote,
    count: z.int().positive(),
    category: z.string().max(80),
    importance: z.enum(["required", "preferred", "unspecified"]),
    support: z.enum(["supported", "related", "gap"]),
    factIds: z.array(Key).max(100),
  })
  .strict()
  .superRefine((priority, ctx) => {
    if (priority.quote.endByte <= priority.quote.startByte) {
      ctx.addIssue({
        code: "custom",
        message: "quote endByte must exceed startByte",
        path: ["quote", "endByte"],
      });
    }
  });

export const PlanAngleV1 = z
  .object({
    angleId: z.string().regex(/^angle-[12]$/),
    title: z.string().min(1).max(80),
    summaryText: z.string().min(1).max(4000),
    factIds: z.array(Key).min(1).max(100),
  })
  .strict();

export const PlanSuggestionV1 = z
  .object({
    suggestionId: z.string().regex(/^sug-[0-9]{3}$/),
    roleId: Key,
    text: z.string().min(1).max(2000),
    factIds: z.array(Key).min(1).max(20),
    usable: z.boolean(),
    unusableReason: z.string().max(200).nullable(),
  })
  .strict();
export type PlanSuggestionV1 = z.infer<typeof PlanSuggestionV1>;

export const PreparationPlanV1 = z
  .object({
    schemaVersion: z.literal(STEP2_SCHEMA_VERSIONS.plan),
    planId: Id,
    preparationId: Id,
    extractionId: Id,
    jdHash: Hash,
    profileVersionId: Id,
    evidenceHash: Hash,
    masterProjectionHash: Hash,
    priorities: z.array(PlanPriorityV1).max(20),
    featuredPriorityIds: z.array(Hash).max(5),
    positioning: z
      .object({
        keepMasterSummary: z.string().max(4000),
        angles: z.array(PlanAngleV1).max(2),
      })
      .strict(),
    suggestions: z.array(PlanSuggestionV1).max(10),
    rationale: z.string().max(2000),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const known = new Set(plan.priorities.map((p) => p.priorityId));
    if (known.size !== plan.priorities.length) {
      ctx.addIssue({
        code: "custom",
        message: "priority ids must be unique",
        path: ["priorities"],
      });
    }
    const featured = new Set<string>();
    for (const [index, id] of plan.featuredPriorityIds.entries()) {
      if (featured.has(id)) {
        ctx.addIssue({
          code: "custom",
          message: "featured priority ids must be unique",
          path: ["featuredPriorityIds", index],
        });
      }
      featured.add(id);
      if (!known.has(id)) {
        ctx.addIssue({
          code: "custom",
          message: "featured priority id names no plan priority",
          path: ["featuredPriorityIds", index],
        });
      }
    }
    const angles = plan.positioning.angles.map((a) => a.angleId);
    if (new Set(angles).size !== angles.length) {
      ctx.addIssue({
        code: "custom",
        message: "angle ids must be unique",
        path: ["positioning", "angles"],
      });
    }
    const suggestions = plan.suggestions.map((s) => s.suggestionId);
    if (new Set(suggestions).size !== suggestions.length) {
      ctx.addIssue({
        code: "custom",
        message: "suggestion ids must be unique",
        path: ["suggestions"],
      });
    }
  });
export type PreparationPlanV1 = z.infer<typeof PreparationPlanV1>;

/**
 * Worker per-item proposal validation record (S2-B, stored as
 * `step2_plans.validation_json`): which priorities/angles were
 * dropped and why, and per-suggestion usable flags with kept and
 * dropped citations. Reasons reuse the stable step2-claims/1 codes
 * plus QUOTE_* and UNKNOWN_ROLE/NO_EVIDENCE/EMPLOYER_SWAP.
 */
export const PlanValidationV1 = z
  .object({
    schemaVersion: z.literal(STEP2_PLAN_VALIDATION_VERSION),
    droppedPriorities: z
      .array(
        z
          .object({
            index: z.int().nonnegative(),
            quote: z.string().max(512),
            reason: z.string().max(64),
          })
          .strict(),
      )
      .max(20),
    droppedAngles: z
      .array(
        z
          .object({
            index: z.int().nonnegative(),
            title: z.string().max(80),
            reason: z.string().max(64),
          })
          .strict(),
      )
      .max(2),
    suggestions: z
      .array(
        z
          .object({
            suggestionId: z.string().regex(/^sug-[0-9]{3}$/),
            usable: z.boolean(),
            unusableReason: z.string().max(200).nullable(),
            keptFactIds: z.array(Key).max(20),
            droppedFactIds: z
              .array(
                z
                  .object({
                    factId: z.string().min(1).max(128),
                    reason: z.string().max(64),
                  })
                  .strict(),
              )
              .max(20),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type PlanValidationV1 = z.infer<typeof PlanValidationV1>;

/* ------------------------------------------------------------------ */
/* 1.4 Editor draft                                                    */
/* ------------------------------------------------------------------ */

const DraftTargetSuggestion = z
  .object({
    kind: z.literal("suggestion"),
    suggestionId: z.string().regex(/^sug-[0-9]{3}$/),
  })
  .strict();
const DraftTargetBullet = z
  .object({ kind: z.literal("bullet"), factId: Key })
  .strict();

export const Step2DraftOperationV1 = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("add"),
      operationId: Id,
      suggestionId: z.string().regex(/^sug-[0-9]{3}$/),
      roleId: Key,
      editedText: z.string().max(2000).nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal("replace"),
      operationId: Id,
      targetFactId: Key,
      roleId: Key,
      suggestionId: z.string().regex(/^sug-[0-9]{3}$/).nullable(),
      editedText: z.string().min(1).max(2000).nullable(),
    })
    .strict()
    .superRefine((op, ctx) => {
      const hasSuggestion = op.suggestionId !== null;
      const hasText =
        op.editedText !== null && op.editedText.trim() !== "";
      if (hasSuggestion === hasText) {
        ctx.addIssue({
          code: "custom",
          message:
            "replace carries exactly one of suggestionId or editedText",
          path: ["suggestionId"],
        });
      }
    }),
  z
    .object({
      op: z.literal("exclude"),
      operationId: Id,
      targetFactId: Key,
    })
    .strict(),
  z
    .object({
      op: z.literal("edit"),
      operationId: Id,
      target: z.discriminatedUnion("kind", [
        DraftTargetSuggestion,
        DraftTargetBullet,
      ]),
      text: z.string().min(1).max(2000),
    })
    .strict(),
]);
export type Step2DraftOperationV1 = z.infer<typeof Step2DraftOperationV1>;

export const Step2DraftV1 = z
  .object({
    schemaVersion: z.literal(STEP2_SCHEMA_VERSIONS.draft),
    planId: Id,
    planHash: Hash,
    summaryText: z.string().max(4000),
    summarySource: z.enum(["master", "angle-1", "angle-2", "edited"]),
    operations: z.array(Step2DraftOperationV1).max(50),
  })
  .strict()
  .superRefine((draft, ctx) => {
    const ids = draft.operations.map((op) => op.operationId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        message: "operation ids must be unique",
        path: ["operations"],
      });
    }
  });
export type Step2DraftV1 = z.infer<typeof Step2DraftV1>;

/* ------------------------------------------------------------------ */
/* 1.5 Validation verdicts                                             */
/* ------------------------------------------------------------------ */

export const Step2SegmentVerdictV1 = z
  .object({
    segmentId: z.string().min(1).max(64),
    kind: z.enum(["summary", "bullet"]),
    roleId: Key.nullable(),
    textHash: Hash,
    normalizedHash: Hash,
    verdict: z.enum(["supported", "needs-evidence"]),
    factIds: z.array(Key).max(20),
    match: z.enum([
      "exact-fact",
      "exact-plan",
      "exact-master",
      "derivation",
      "none",
    ]),
    reason: z.string().max(200).nullable(),
  })
  .strict();

export const Step2ValidationV1 = z
  .object({
    schemaVersion: z.literal(STEP2_SCHEMA_VERSIONS.validation),
    policyVersion: z.literal(STEP2_CLAIMS_POLICY),
    planId: Id,
    planHash: Hash,
    draftHash: Hash,
    segments: z.array(Step2SegmentVerdictV1).max(60),
    budget: z
      .object({
        summaryChars: z.int().nonnegative(),
        perRoleCounts: z
          .array(
            z
              .object({
                roleId: Key,
                bullets: z.int().nonnegative(),
              })
              .strict(),
          )
          .max(50),
        totalBullets: z.int().nonnegative(),
        exceeded: z.boolean(),
      })
      .strict(),
    validatedAt: Time,
  })
  .strict();
export type Step2ValidationV1 = z.infer<typeof Step2ValidationV1>;

/* ------------------------------------------------------------------ */
/* 1.6 Workspace v2                                                    */
/* ------------------------------------------------------------------ */

const Note = z.string().trim().min(1).max(4000);

export const WorkspacePutV2 = z
  .object({
    schemaVersion: z.literal(STEP2_SCHEMA_VERSIONS.workspace),
    extractionId: Id.nullable(),
    profileId: Key.nullable(),
    profileVersionId: Id.nullable(),
    requestKind: z.enum(["INITIAL", "NEW_VERSION", "REVISION"]),
    parentVersionId: Id.nullable(),
    revisionNote: Note.nullable(),
    planId: Id.nullable(),
    planHash: Hash.nullable(),
    recommendationHash: Hash.nullable(),
    draft: Step2DraftV1.nullable(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (
      (body.profileId === null) !== (body.profileVersionId === null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "profile and version are both null or an owned pair",
        path: ["profileId"],
      });
    }
    if ((body.planId === null) !== (body.planHash === null)) {
      ctx.addIssue({
        code: "custom",
        message: "plan id and hash are both null or both present",
        path: ["planId"],
      });
    }
    if (body.draft !== null && body.planId === null) {
      ctx.addIssue({
        code: "custom",
        message: "a draft requires its plan binding",
        path: ["draft"],
      });
    }
    const kind = body.requestKind;
    const hasParent = body.parentVersionId !== null;
    const hasNote = body.revisionNote !== null;
    const ok =
      (kind === "INITIAL" && !hasParent && !hasNote) ||
      (kind === "NEW_VERSION" && hasParent && !hasNote) ||
      (kind === "REVISION" && hasParent && hasNote);
    if (!ok) {
      ctx.addIssue({
        code: "custom",
        message: "request kind, parent, and note disagree",
        path: ["requestKind"],
      });
    }
  });
export type WorkspacePutV2 = z.infer<typeof WorkspacePutV2>;

/**
 * S2-C stored v2 bytes (no migration: `focus_json` holds either a
 * `FocusV1` or this envelope, discriminated by the inner
 * `schemaVersion`). Header fields live in the row columns exactly
 * like v1; the envelope carries only the plan binding plus the
 * editor draft. Saving either version replaces the bytes wholesale;
 * v1 and v2 drafts never merge.
 */
export const WorkspaceStoredV2 = z
  .object({
    schemaVersion: z.literal(STEP2_SCHEMA_VERSIONS.workspace),
    planId: Id.nullable(),
    planHash: Hash.nullable(),
    draft: Step2DraftV1.nullable(),
  })
  .strict()
  .superRefine((stored, ctx) => {
    if ((stored.planId === null) !== (stored.planHash === null)) {
      ctx.addIssue({
        code: "custom",
        message: "plan id and hash are both null or both present",
        path: ["planId"],
      });
    }
    if (stored.draft !== null && stored.planId === null) {
      ctx.addIssue({
        code: "custom",
        message: "a draft requires its plan binding",
        path: ["draft"],
      });
    }
  });
export type WorkspaceStoredV2 = z.infer<typeof WorkspaceStoredV2>;

/**
 * S2-C v2 workspace view: same envelope as the v1
 * `WorkspaceView`, with a `WorkspacePutV2` draft rebuilt from the
 * row header plus the stored envelope. GET responses carry the
 * stored version's schema; clients branch on
 * `draft.schemaVersion`.
 */
export const WorkspaceViewV2 = z
  .object({
    jobId: Id,
    revision: z.int().positive(),
    draft: WorkspacePutV2,
    recommendations: RecommendationV1.nullable(),
    lastRequestId: Id.nullable(),
    lastSubmittedRevision: z.int().positive().nullable(),
    updatedAt: Time,
  })
  .strict();
export type WorkspaceViewV2 = z.infer<typeof WorkspaceViewV2>;

/* ------------------------------------------------------------------ */
/* 1.7 Commands, replies, failures                                     */
/* ------------------------------------------------------------------ */

export const PrepareCommandV1 = z
  .object({
    schemaVersion: z.literal(STEP2_SCHEMA_VERSIONS.prepareCommand),
    operationId: Id,
    observedRowVersion: z.int().positive(),
    profileId: Key.nullable(),
  })
  .strict();
export type PrepareCommandV1 = z.infer<typeof PrepareCommandV1>;

export const PrepareRetryBodyV1 = z
  .object({
    schemaVersion: z.literal(STEP2_SCHEMA_VERSIONS.prepareRetry),
    observedAttemptId: Id,
    observedRowVersion: z.int().positive(),
  })
  .strict();
export type PrepareRetryBodyV1 = z.infer<typeof PrepareRetryBodyV1>;

export const ValidateDraftBodyV1 = z
  .object({
    schemaVersion: z.literal(STEP2_SCHEMA_VERSIONS.validateDraft),
    workspaceRevision: z.int().positive(),
    summaryText: z.string().max(4000),
    operations: z.array(Step2DraftOperationV1).max(50),
  })
  .strict();
export type ValidateDraftBodyV1 = z.infer<typeof ValidateDraftBodyV1>;

export const PreparationFailure = z
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
    stage: PreparationStage.nullable(),
    occurredAt: Time,
    action: z.enum([
      "edit_focus",
      "edit_profile",
      "open_settings",
      "retry",
      "wait",
    ]),
    retryAfterSeconds: z.int().nonnegative().nullable(),
    launchSubcode: z.enum(["ENOENT", "EACCES", "OTHER"]).nullable(),
  })
  .strict();
export type PreparationFailure = z.infer<typeof PreparationFailure>;

/** Codes preparation never emits (no renderer runs; proposal defects are INVALID_RESPONSE). */
export const PREPARATION_NEVER_EMITS = [
  "RENDER_FAILED",
  "CLAIM_VALIDATION",
] as const;

/** Preparation failures that forbid explicit retry (mirrors R eligibility). */
export const PREPARATION_NON_RETRYABLE = [
  "INPUT_STALE",
  "PROFILE_UNAVAILABLE",
] as const;

export const PreparationStatusV1 = z
  .object({
    schemaVersion: z.literal("step2-preparation-status/v1"),
    preparationId: Id.nullable(),
    jobId: Id,
    state: z.enum([
      "ABSENT",
      "PENDING",
      "QUEUED",
      "RUNNING",
      "SUCCEEDED",
      "FAILED",
    ]),
    binding: IntakeBindingV1.nullable(),
    extractionId: Id.nullable(),
    acceptedPlanId: Id.nullable(),
    acceptedPlanHash: Hash.nullable(),
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
            stage: PreparationStage,
            source: z.enum(["provider", "cached"]),
            recordedAt: Time,
          })
          .strict(),
      )
      .max(5),
    failure: PreparationFailure.nullable(),
    retryAllowed: z.boolean(),
    serverNow: Time,
  })
  .strict();
export type PreparationStatusV1 = z.infer<typeof PreparationStatusV1>;

export const PlanReplyV1 = z
  .object({
    ok: z.literal(true),
    plan: PreparationPlanV1,
    planHash: Hash,
    validatedAt: Time,
    supersedesPlanId: Id.nullable(),
  })
  .strict();
export type PlanReplyV1 = z.infer<typeof PlanReplyV1>;

export const ValidateDraftReplyV1 = z
  .object({
    ok: z.literal(true),
    validationId: Id,
    validation: Step2ValidationV1,
  })
  .strict();
export type ValidateDraftReplyV1 = z.infer<typeof ValidateDraftReplyV1>;

/** Additive per-item preparation block for GET intake batch (§4.3). */
export const BatchItemPreparationV1 = z
  .object({
    state: z.enum([
      "ABSENT",
      "PENDING",
      "QUEUED",
      "RUNNING",
      "SUCCEEDED",
      "FAILED",
    ]),
    preparationId: Id.nullable(),
    acceptedPlanId: Id.nullable(),
    failureCode: PreparationFailure.shape.code.nullable(),
    retryAllowed: z.boolean(),
    jobId: Id.nullable(),
  })
  .strict()
  .nullable();
export type BatchItemPreparationV1 = z.infer<typeof BatchItemPreparationV1>;

/* ------------------------------------------------------------------ */
/* Provider planning envelopes (§9)                                    */
/* ------------------------------------------------------------------ */

export const PreparationInputV1 = z
  .object({
    schemaVersion: z.literal(STEP2_SCHEMA_VERSIONS.preparationInput),
    promptVersion: z.literal(PREPARE_PROMPT_VERSION),
    jobId: z.string().min(1),
    jobTitle: z.string(),
    company: z.string(),
    jdSnapshotId: z.string().min(1),
    jdText: z.string().min(1).max(200_000),
    candidateSnapshotId: z.string().min(1),
    profile: StoredProfilePayload,
    approvedFactIds: z.array(z.string().min(1)).max(500),
    masterBullets: z
      .array(
        z
          .object({
            roleId: Key,
            factId: Key,
            text: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(500),
    budgets: z
      .object({
        priorities: z.int().positive(),
        suggestions: z.int().positive(),
        angles: z.int().positive(),
      })
      .strict(),
  })
  .strict();
export type PreparationInputV1 = z.infer<typeof PreparationInputV1>;

export const PreparationProposalV1 = z
  .object({
    schemaVersion: z.literal(STEP2_SCHEMA_VERSIONS.preparationProposal),
    jdSnapshotId: z.string().min(1),
    candidateSnapshotId: z.string().min(1),
    priorities: z
      .array(
        z
          .object({
            quote: PlanQuote,
            count: z.int().positive(),
            category: z.string().max(80),
            importance: z.enum(["required", "preferred", "unspecified"]),
            matchStatus: z.enum(["matched", "partial", "gap", "unsupported"]),
            factIds: z.array(z.string().min(1)).max(100),
          })
          .strict(),
      )
      .max(20),
    angles: z
      .array(
        z
          .object({
            title: z.string().min(1).max(80),
            summaryText: z.string().min(1).max(4000),
            factIds: z.array(z.string().min(1)).min(1).max(100),
          })
          .strict(),
      )
      .max(2),
    suggestions: z
      .array(
        z
          .object({
            roleId: z.string().min(1).max(128),
            text: z.string().min(1).max(2000),
            factIds: z.array(z.string().min(1)).min(1).max(20),
          })
          .strict(),
      )
      .max(10),
    rationale: z.string().max(2000),
  })
  .strict();
export type PreparationProposalV1 = z.infer<typeof PreparationProposalV1>;

/* ------------------------------------------------------------------ */
/* Master projection (hash-free; §2 digests live in tailoring)        */
/* ------------------------------------------------------------------ */

export interface MasterBullet {
  roleId: string;
  factId: string;
  text: string;
}

/**
 * `step2-master-bullets/1`: approved achievements in payload order,
 * grouped by employment id (unlinked achievements under `""`). The
 * editor's "existing master bullets by role" and the plan's
 * `masterProjectionHash` input. Total, deterministic, provider-free.
 */
export function masterBulletsByRole(
  payload: StoredProfilePayloadType,
): MasterBullet[] {
  const approved = new Set(
    payload.achievements
      .filter((achievement) => achievement.verification === "APPROVED")
      .map((achievement) => achievement.factId),
  );
  const bullets: MasterBullet[] = [];
  for (const employment of payload.employment) {
    for (const achievement of payload.achievements) {
      if (
        achievement.employmentId === employment.id &&
        approved.has(achievement.factId)
      ) {
        bullets.push({
          roleId: employment.id,
          factId: achievement.factId,
          text: canonicalText(achievement.text),
        });
      }
    }
  }
  for (const achievement of payload.achievements) {
    if (
      achievement.employmentId === undefined &&
      approved.has(achievement.factId)
    ) {
      bullets.push({
        roleId: "",
        factId: achievement.factId,
        text: canonicalText(achievement.text),
      });
    }
  }
  return bullets;
}

/* ------------------------------------------------------------------ */
/* Preparation state machine + replay decisions (§4.1, §6)              */
/* ------------------------------------------------------------------ */

export const PreparationRowState = z.enum([
  "PENDING",
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
]);
export type PreparationRowState = z.infer<typeof PreparationRowState>;

export type PreparationEvent =
  | "schedule"
  | "claim"
  | "succeed"
  | "fail"
  | "retry"
  | "supersede";

const PREPARATION_TRANSITIONS: Record<
  PreparationRowState,
  Partial<Record<PreparationEvent, PreparationRowState>>
> = {
  PENDING: { schedule: "QUEUED" },
  QUEUED: { claim: "RUNNING", schedule: "QUEUED" },
  RUNNING: { succeed: "SUCCEEDED", fail: "FAILED" },
  SUCCEEDED: { supersede: "QUEUED" },
  FAILED: { retry: "QUEUED", schedule: "QUEUED", supersede: "QUEUED" },
};

export type PreparationTransition =
  | { ok: true; to: PreparationRowState }
  | { ok: false; error: string };

export function planPreparationTransition(
  from: PreparationRowState,
  event: PreparationEvent,
): PreparationTransition {
  const to = PREPARATION_TRANSITIONS[from]?.[event];
  if (to === undefined) {
    return {
      ok: false,
      error: `preparation event '${event}' cannot run in state '${from}'`,
    };
  }
  return { ok: true, to };
}

/**
 * P idempotency decision (pure pin of §4.1 step 2): replay precedes
 * every check; same operation id with changed bytes is a conflict.
 */
export function resolvePrepareReplay(input: {
  lastOperationId: string | null;
  lastOperationHash: string | null;
  operationId: string;
  operationHash: string;
}): "accept" | "replay" | "mismatch" {
  if (input.lastOperationId === null) {
    return "accept";
  }
  if (input.lastOperationId !== input.operationId) {
    return "accept";
  }
  return input.lastOperationHash === input.operationHash
    ? "replay"
    : "mismatch";
}

/* ------------------------------------------------------------------ */
/* §10 budgets                                                         */
/* ------------------------------------------------------------------ */

export const STEP2_BUDGETS = {
  summaryChars: 4000,
  bulletsPerRole: 3,
  totalBullets: 14,
  operations: 50,
  suggestions: 5,
  featuredPriorities: 5,
  angles: 2,
} as const;

export interface ProjectedBulletCounts {
  perRole: Array<{ roleId: string; bullets: number }>;
  total: number;
}

/**
 * Project final per-role bullet counts from the master projection
 * plus ordered draft operations. Add appends, replace swaps in
 * place, exclude removes, edit changes nothing. Unknown references
 * are ignored here (W rejects them); this function counts shape.
 */
export function projectBulletCounts(
  master: MasterBullet[],
  operations: Step2DraftOperationV1[],
): ProjectedBulletCounts {
  const byRole = new Map<string, string[]>();
  const push = (roleId: string, key: string): void => {
    const list = byRole.get(roleId) ?? [];
    list.push(key);
    byRole.set(roleId, list);
  };
  for (const bullet of master) {
    push(bullet.roleId, `master:${bullet.factId}`);
  }
  const removeMaster = (factId: string): void => {
    for (const [roleId, list] of byRole) {
      const index = list.indexOf(`master:${factId}`);
      if (index >= 0) {
        list.splice(index, 1);
        byRole.set(roleId, list);
        return;
      }
    }
  };
  for (const op of operations) {
    if (op.op === "add") {
      push(op.roleId, `add:${op.operationId}`);
    } else if (op.op === "replace") {
      removeMaster(op.targetFactId);
      push(op.roleId, `replace:${op.operationId}`);
    } else if (op.op === "exclude") {
      removeMaster(op.targetFactId);
    }
  }
  const perRole = [...byRole.entries()]
    .map(([roleId, bullets]) => ({ roleId, bullets: bullets.length }))
    .sort((a, b) => (a.roleId < b.roleId ? -1 : a.roleId > b.roleId ? 1 : 0));
  const total = perRole.reduce((sum, row) => sum + row.bullets, 0);
  return { perRole, total };
}

/**
 * Advisory length-guidance report. `exceeded` is presentation
 * guidance (counts vs the 4000-char / 3-per-role / 14-total
 * concision hints), never a generation rejection: G, the
 * worker, and the editor submit over-guidance drafts as is.
 * Historical shape preserved — stored validation rows parse
 * unchanged.
 */
export interface Step2BudgetReport {
  summaryChars: number;
  perRoleCounts: Array<{ roleId: string; bullets: number }>;
  totalBullets: number;
  exceeded: boolean;
}

export function checkStep2Budgets(input: {
  summaryText: string;
  master: MasterBullet[];
  operations: Step2DraftOperationV1[];
}): Step2BudgetReport {
  const projected = projectBulletCounts(input.master, input.operations);
  const summaryChars = [...input.summaryText].length;
  const exceeded =
    summaryChars > STEP2_BUDGETS.summaryChars ||
    projected.total > STEP2_BUDGETS.totalBullets ||
    projected.perRole.some(
      (row) => row.bullets > STEP2_BUDGETS.bulletsPerRole,
    );
  return {
    summaryChars,
    perRoleCounts: projected.perRole,
    totalBullets: projected.total,
    exceeded,
  };
}

/* ------------------------------------------------------------------ */
/* S2-D generation inputs (§3.5) and segment derivation (§7.5)          */
/* ------------------------------------------------------------------ */

export const STEP2_EDITED_INPUTS_VERSION = "step2-edited-inputs/v1";
export const STEP2_POLICY_VERSIONS_VERSION = "step2-policy-versions/v1";

/**
 * Frozen edited inputs carried in
 * `step2_generation_inputs.edited_inputs_json`: the exact draft
 * bytes minus the plan hash (a sibling column). Written once by G,
 * read by the worker; never merged with live workspace state.
 */
export const Step2EditedInputsV1 = z
  .object({
    schemaVersion: z.literal(STEP2_EDITED_INPUTS_VERSION),
    planId: Id,
    summaryText: z.string().max(4000),
    summarySource: z.enum(["master", "angle-1", "angle-2", "edited"]),
    operations: z.array(Step2DraftOperationV1).max(50),
  })
  .strict();
export type Step2EditedInputsV1 = z.infer<typeof Step2EditedInputsV1>;

/** Frozen policy lineage in `policy_versions_json`. Literals only. */
export const Step2PolicyVersionsV1 = z
  .object({
    schemaVersion: z.literal(STEP2_POLICY_VERSIONS_VERSION),
    claims: z.literal(STEP2_CLAIMS_POLICY),
    master: z.literal(STEP2_MASTER_PROJECTION),
    prompt: z.literal(PREPARE_PROMPT_VERSION),
  })
  .strict();
export type Step2PolicyVersionsV1 = z.infer<typeof Step2PolicyVersionsV1>;

export interface Step2DerivedSegment {
  segmentId: string;
  kind: "summary" | "bullet";
  roleId: string | null;
  text: string;
  citedFactIds: string[];
}

/**
 * Derive validation segments from exact draft bytes (contracts
 * §7.5). The validate endpoint and the S2-D generation gate share
 * this function so advisory verdicts and the blocking gate can
 * never disagree on what text is included.
 *
 * One summary segment citing the union of all suggestion and angle
 * fact ids of the bound plan; one segment per add/replace/edit op;
 * exclude produces no segment (excluded content never blocks).
 * Unknown plan references yield no segment here — W rejects them
 * on save, and the generation applier below fails closed on them.
 *
 * S2-D amendment to §7.5 (recorded in contracts §13): the role of
 * an edit-on-suggestion comes from the first matching add OR
 * replace-with-suggestion instance in op order, because edits apply
 * to replace instances too (the editor renders it that way). The
 * S2-A text named adds only, which validated a replace-instance
 * edit against the wrong role (or none) whenever a replace preceded
 * the first add of the same suggestion.
 */
export function deriveStep2Segments(input: {
  plan: PreparationPlanV1;
  master: MasterBullet[];
  summaryText: string;
  operations: Step2DraftOperationV1[];
}): Step2DerivedSegment[] {
  const suggestionsById = new Map(
    input.plan.suggestions.map((suggestion) => [suggestion.suggestionId, suggestion]),
  );
  const instanceRoleBySuggestion = new Map<string, string>();
  for (const op of input.operations) {
    if (op.op === "add") {
      if (!instanceRoleBySuggestion.has(op.suggestionId)) {
        instanceRoleBySuggestion.set(op.suggestionId, op.roleId);
      }
    } else if (op.op === "replace" && op.suggestionId !== null) {
      if (!instanceRoleBySuggestion.has(op.suggestionId)) {
        instanceRoleBySuggestion.set(op.suggestionId, op.roleId);
      }
    }
  }
  const bulletRoleByFact = new Map<string, string>();
  for (const bullet of input.master) {
    if (!bulletRoleByFact.has(bullet.factId)) {
      bulletRoleByFact.set(bullet.factId, bullet.roleId);
    }
  }
  const planFactIds = new Set<string>();
  for (const suggestion of input.plan.suggestions) {
    for (const factId of suggestion.factIds) {
      planFactIds.add(factId);
    }
  }
  for (const angle of input.plan.positioning.angles) {
    for (const factId of angle.factIds) {
      planFactIds.add(factId);
    }
  }
  const segments: Step2DerivedSegment[] = [
    {
      segmentId: "summary",
      kind: "summary",
      roleId: null,
      text: input.summaryText,
      citedFactIds: [...planFactIds],
    },
  ];
  for (const op of input.operations) {
    if (op.op === "exclude") {
      continue;
    }
    if (op.op === "add") {
      const suggestion = suggestionsById.get(op.suggestionId);
      if (suggestion === undefined) {
        continue;
      }
      segments.push({
        segmentId: `op:${op.operationId}`,
        kind: "bullet",
        roleId: op.roleId,
        text: op.editedText ?? suggestion.text,
        citedFactIds: [...suggestion.factIds],
      });
    } else if (op.op === "replace") {
      if (op.suggestionId !== null) {
        const suggestion = suggestionsById.get(op.suggestionId);
        if (suggestion === undefined) {
          continue;
        }
        segments.push({
          segmentId: `op:${op.operationId}`,
          kind: "bullet",
          roleId: op.roleId,
          text: suggestion.text,
          citedFactIds: [...suggestion.factIds],
        });
      } else if (op.editedText !== null) {
        segments.push({
          segmentId: `op:${op.operationId}`,
          kind: "bullet",
          roleId: op.roleId,
          text: op.editedText,
          citedFactIds: [op.targetFactId],
        });
      }
    } else if (op.target.kind === "suggestion") {
      const suggestion = suggestionsById.get(op.target.suggestionId);
      if (suggestion === undefined) {
        continue;
      }
      segments.push({
        segmentId: `op:${op.operationId}`,
        kind: "bullet",
        roleId: instanceRoleBySuggestion.get(op.target.suggestionId) ?? null,
        text: op.text,
        citedFactIds: [...suggestion.factIds],
      });
    } else {
      segments.push({
        segmentId: `op:${op.operationId}`,
        kind: "bullet",
        roleId: bulletRoleByFact.get(op.target.factId) ?? null,
        text: op.text,
        citedFactIds: [op.target.factId],
      });
    }
  }
  return segments;
}

export interface Step2FinalBullet {
  roleId: string;
  text: string;
  kind: "master" | "added" | "replaced";
  /** Master attribution; untouched master rows render verbatim. */
  factId: string | null;
  suggestionId: string | null;
  operationId: string | null;
  edited: boolean;
  /**
   * Op whose text this bullet renders (the add/replace that created
   * it, or the edit that last reworded it); null for untouched
   * master rows. Generation binds each bullet to its own op's
   * verdict — never by text matching, so identical texts under
   * different ops cannot cross-bind their fact citations.
   */
  sourceOperationId: string | null;
}

export interface Step2FinalRoleGroup {
  roleId: string;
  bullets: Step2FinalBullet[];
}

/**
 * Apply ordered draft ops over the master projection for
 * generation. Same placement rules as the S2-C display applier
 * (add appends, replace removes its target and lands in the op
 * role, exclude drops, edits reword the first matching instance in
 * place) — except every unknown reference throws instead of
 * rendering an orphan: W validates references on save, so an
 * unknown id at generation time is corruption, not user input.
 * Excluded rows are omitted from the output (never rendered, never
 * reinstated). Groups keep display order; bullets within a group
 * keep display order.
 */
export function applyEditedBullets(input: {
  master: MasterBullet[];
  /** Minimal surface: the applier only reads suggestion ids/text, so v1 and v2 plans both apply. */
  plan: { suggestions: Array<{ suggestionId: string; text: string }> };
  operations: Step2DraftOperationV1[];
}): Step2FinalRoleGroup[] {
  const suggestions = new Map(
    input.plan.suggestions.map((suggestion) => [suggestion.suggestionId, suggestion]),
  );
  interface Row extends Step2FinalBullet {
    key: string;
    excluded: boolean;
  }
  const groups = new Map<string, Row[]>();
  const rowsByFact = new Map<string, Row>();
  /** Added/replaced instances in op order (edit targeting). */
  const instances: Row[] = [];
  const listFor = (roleId: string): Row[] => {
    const existing = groups.get(roleId);
    if (existing !== undefined) {
      return existing;
    }
    const created: Row[] = [];
    groups.set(roleId, created);
    return created;
  };
  for (const bullet of input.master) {
    const row: Row = {
      key: `master:${bullet.factId}`,
      roleId: bullet.roleId,
      text: bullet.text,
      kind: "master",
      factId: bullet.factId,
      suggestionId: null,
      operationId: null,
      edited: false,
      sourceOperationId: null,
      excluded: false,
    };
    listFor(bullet.roleId).push(row);
    if (!rowsByFact.has(bullet.factId)) {
      rowsByFact.set(bullet.factId, row);
    }
  }
  const removeRow = (row: Row): void => {
    const list = groups.get(row.roleId);
    if (list === undefined) {
      return;
    }
    const index = list.indexOf(row);
    if (index >= 0) {
      list.splice(index, 1);
    }
  };
  for (const op of input.operations) {
    if (op.op === "add") {
      const suggestion = suggestions.get(op.suggestionId);
      if (suggestion === undefined) {
        throw new Error(
          `stored draft adds unknown suggestion '${op.suggestionId}'; inspect the row, do not trust it`,
        );
      }
      const added: Row = {
        key: `add:${op.operationId}`,
        roleId: op.roleId,
        text: op.editedText ?? suggestion.text,
        kind: "added",
        factId: null,
        suggestionId: op.suggestionId,
        operationId: op.operationId,
        edited: op.editedText !== null,
        sourceOperationId: op.operationId,
        excluded: false,
      };
      listFor(op.roleId).push(added);
      instances.push(added);
    } else if (op.op === "replace") {
      const target = rowsByFact.get(op.targetFactId);
      let text: string;
      if (op.suggestionId !== null) {
        const suggestion = suggestions.get(op.suggestionId);
        if (suggestion === undefined) {
          throw new Error(
            `stored draft replaces with unknown suggestion '${op.suggestionId}'; inspect the row, do not trust it`,
          );
        }
        text = suggestion.text;
      } else if (op.editedText !== null) {
        text = op.editedText;
      } else {
        throw new Error(
          `stored replace op '${op.operationId}' carries neither suggestion nor text; inspect the row, do not trust it`,
        );
      }
      // Mirror the display applier: replacing an already-removed
      // target still lands the replacement (W pins references, not
      // op-order liveness).
      if (target !== undefined) {
        removeRow(target);
        rowsByFact.delete(op.targetFactId);
      }
      const replaced: Row = {
        key: `replace:${op.operationId}`,
        roleId: op.roleId,
        text,
        kind: "replaced",
        factId: op.targetFactId,
        suggestionId: op.suggestionId,
        operationId: op.operationId,
        edited: op.editedText !== null,
        sourceOperationId: op.operationId,
        excluded: false,
      };
      listFor(op.roleId).push(replaced);
      instances.push(replaced);
    } else if (op.op === "exclude") {
      // Mirror the display applier: excluding an already-removed
      // target is a no-op, never an error.
      const target = rowsByFact.get(op.targetFactId);
      if (target !== undefined) {
        target.excluded = true;
      }
    } else if (op.target.kind === "bullet") {
      // Mirror the display applier: edits to removed rows change
      // nothing (the edit segment still gates generation).
      const bullet = rowsByFact.get(op.target.factId);
      if (bullet !== undefined) {
        bullet.text = op.text;
        bullet.edited = true;
        bullet.sourceOperationId = op.operationId;
      }
    } else if (op.target.kind === "suggestion") {
      const suggestionId = op.target.suggestionId;
      const instance = instances.find((row) => row.suggestionId === suggestionId);
      if (instance === undefined) {
        throw new Error(
          `stored draft edits suggestion '${suggestionId}' with no added instance; inspect the row, do not trust it`,
        );
      }
      instance.text = op.text;
      instance.edited = true;
      instance.sourceOperationId = op.operationId;
    } else {
      throw new Error("internal: edit op carries an unknown target kind");
    }
  }
  const groupsOut: Step2FinalRoleGroup[] = [];
  for (const [roleId, rows] of groups) {
    const bullets = rows
      .filter((row) => !row.excluded)
      .map((row): Step2FinalBullet => ({
        roleId: row.roleId,
        text: row.text,
        kind: row.kind,
        factId: row.factId,
        suggestionId: row.suggestionId,
        operationId: row.operationId,
        edited: row.edited,
        sourceOperationId: row.sourceOperationId,
      }));
    if (bullets.length > 0) {
      groupsOut.push({ roleId, bullets });
    }
  }
  return groupsOut;
}
