import { z } from "zod";
import { StoredProfilePayload } from "./candidate";
import { canonicalText } from "./canonical";
import { RecommendationV1 } from "./tailoringWorkspace";
import {
  EntityId as Id,
  IsoUtcDateTime as Time,
  Sha256Hex as Hash,
} from "./fields";

/**
 * WO-1.3-S2-CP-A frozen correction contracts: server-derived segment
 * provenance, exact JD-priority linkage, server-derived eligible
 * roles, selected-summary-only anchors, and the one Generate
 * transition.
 *
 * Pure domain module: Zod schemas plus deterministic derivation
 * helpers. No database, worker, provider, or UI code. Normative text
 * lives in `docs/contracts/v1.3-step2-correction-contracts.md`; this
 * module is its executable pin. S2-CP-B/S2-CP-C consume these exact
 * schemas. Historical v1 formats in `./step2` are untouched: old
 * bytes keep their readers, hashes, and blocking semantics.
 *
 * Trust rule (R-ADR-026): provenance, acceptance, eligible roles,
 * evidence verdicts, and scores are derived server-side from
 * immutable origins, saved operations, and exact text. Provider and
 * public payloads cannot assign them — every schema below is strict
 * and carries no such field.
 */

export const STEP2_CORRECTION_VERSIONS = {
  plan: "step2-plan/v2",
  draft: "step2-draft/v2",
  validation: "step2-validation/v2",
  workspace: "tailoring-workspace/v3",
  editedInputs: "step2-edited-inputs/v2",
  policyVersions: "step2-policy-versions/v2",
  validateDraft: "step2-validate-draft/v2",
  preparationInput: "preparation-input/v2",
  preparationProposal: "preparation-proposal/v2",
  planValidation: "step2-plan-validation/v2",
} as const;

export const PREPARE_PROMPT_VERSION_V2 = "prepare-prompt/v2";
export const STEP2_CLAIMS_POLICY_V2 = "step2-claims/2";

/* ------------------------------------------------------------------ */
/* Provenance                                                          */
/* ------------------------------------------------------------------ */

/**
 * Server-derived segment provenance (`step2-claims/2` categories).
 * Exhaustive: every included summary or experience segment freezes
 * exactly one value. Only `VERIFIED_SOURCE` counts as
 * machine-verified; the other two never inflate verified coverage.
 */
export const Step2Provenance = z.enum([
  "VERIFIED_SOURCE",
  "USER_ACCEPTED_AI",
  "USER_EDITED",
]);
export type Step2Provenance = z.infer<typeof Step2Provenance>;

export const PROVENANCE_REVIEW_LABELS: Record<Step2Provenance, string> = {
  VERIFIED_SOURCE: "Verified source",
  USER_ACCEPTED_AI: "AI suggestion · accepted",
  USER_EDITED: "User edit",
};

export function isMachineVerified(provenance: Step2Provenance): boolean {
  return provenance === "VERIFIED_SOURCE";
}

/** Deterministic structural-failure codes. Human copy lives in renderers. */
export const STEP2_STRUCTURAL_REASONS = {
  UNKNOWN_ORIGIN: "UNKNOWN_ORIGIN",
  INVALID_ANCHOR: "INVALID_ANCHOR",
  PRIORITY_LINK_MISSING: "PRIORITY_LINK_MISSING",
  FOREIGN_PRIORITY: "FOREIGN_PRIORITY",
  UNKNOWN_ROLE: "UNKNOWN_ROLE",
  FOREIGN_ROLE: "FOREIGN_ROLE",
  UNUSABLE_SUGGESTION: "UNUSABLE_SUGGESTION",
  FOREIGN_EMPLOYER: "FOREIGN_EMPLOYER",
  MIXED_OWNERSHIP: "MIXED_OWNERSHIP",
  PROVIDER_ROLE_INELIGIBLE: "PROVIDER_ROLE_INELIGIBLE",
  CHRONOLOGY: "CHRONOLOGY",
} as const;
export type Step2StructuralReason =
  (typeof STEP2_STRUCTURAL_REASONS)[keyof typeof STEP2_STRUCTURAL_REASONS];

const Key = z.string().min(1).max(128);

/* ------------------------------------------------------------------ */
/* Accepted plan v2 (priority links; eligibility derived, not stored)  */
/* ------------------------------------------------------------------ */

const PlanQuoteV2 = z
  .object({
    text: z.string().min(1).max(512),
    startByte: z.int().nonnegative(),
    endByte: z.int().positive(),
  })
  .strict();

export const PlanPriorityV2 = z
  .object({
    priorityId: Hash,
    quote: PlanQuoteV2,
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

export const PlanAngleV2 = z
  .object({
    angleId: z.string().regex(/^angle-[12]$/),
    title: z.string().min(1).max(80),
    summaryText: z.string().min(1).max(4000),
    factIds: z.array(Key).min(1).max(100),
    priorityIds: z.array(Hash).min(1).max(20),
  })
  .strict();

export const PlanSuggestionV2 = z
  .object({
    suggestionId: z.string().regex(/^sug-[0-9]{3}$/),
    roleId: Key,
    text: z.string().min(1).max(2000),
    factIds: z.array(Key).min(1).max(20),
    priorityIds: z.array(Hash).min(1).max(20),
    usable: z.boolean(),
    unusableReason: z.string().max(200).nullable(),
  })
  .strict();
export type PlanSuggestionV2 = z.infer<typeof PlanSuggestionV2>;

export const PreparationPlanV2 = z
  .object({
    schemaVersion: z.literal(STEP2_CORRECTION_VERSIONS.plan),
    planId: Id,
    preparationId: Id,
    extractionId: Id,
    jdHash: Hash,
    profileVersionId: Id,
    evidenceHash: Hash,
    masterProjectionHash: Hash,
    priorities: z.array(PlanPriorityV2).max(20),
    featuredPriorityIds: z.array(Hash).max(5),
    positioning: z
      .object({
        keepMasterSummary: z.string().max(4000),
        angles: z.array(PlanAngleV2).max(2),
      })
      .strict(),
    suggestions: z.array(PlanSuggestionV2).max(10),
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
    const checkLinks = (
      links: string[],
      path: Array<string | number>,
      what: string,
    ): void => {
      const seen = new Set<string>();
      for (const [index, id] of links.entries()) {
        if (seen.has(id)) {
          ctx.addIssue({
            code: "custom",
            message: `${what} priority ids must be unique`,
            path: [...path, index],
          });
        }
        seen.add(id);
        if (!known.has(id)) {
          ctx.addIssue({
            code: "custom",
            message: `${what} priority id names no priority of this plan`,
            path: [...path, index],
          });
        }
      }
    };
    plan.positioning.angles.forEach((angle, angleIndex) => {
      checkLinks(angle.priorityIds, ["positioning", "angles", angleIndex, "priorityIds"], "angle");
    });
    plan.suggestions.forEach((suggestion, suggestionIndex) => {
      checkLinks(suggestion.priorityIds, ["suggestions", suggestionIndex, "priorityIds"], "suggestion");
    });
  });
export type PreparationPlanV2 = z.infer<typeof PreparationPlanV2>;

/**
 * Worker per-item proposal validation record v2 (stored as
 * `step2_plans.validation_json` beside v2 plans): the v1 drop/usable
 * record plus the server-derived priority-link and eligible-role
 * outcomes. Derived values live in the worker's own record — never
 * in provider input.
 */
export const PlanValidationV2 = z
  .object({
    schemaVersion: z.literal(STEP2_CORRECTION_VERSIONS.planValidation),
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
    angles: z
      .array(
        z
          .object({
            angleId: z.string().regex(/^angle-[12]$/),
            keptPriorityIds: z.array(Hash).max(20),
            droppedPriorityIds: z
              .array(
                z
                  .object({
                    priorityId: z.string().min(1).max(128),
                    reason: z.string().max(64),
                  })
                  .strict(),
              )
              .max(20),
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
            keptPriorityIds: z.array(Hash).max(20),
            droppedPriorityIds: z
              .array(
                z
                  .object({
                    priorityId: z.string().min(1).max(128),
                    reason: z.string().max(64),
                  })
                  .strict(),
              )
              .max(20),
            eligibleRoleIds: z.array(Key).max(50),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type PlanValidationV2 = z.infer<typeof PlanValidationV2>;

/* ------------------------------------------------------------------ */
/* Editor draft v2 (stable origins; edited-ness derived, not declared) */
/* ------------------------------------------------------------------ */

const DraftTargetSuggestionV2 = z
  .object({
    kind: z.literal("suggestion"),
    suggestionId: z.string().regex(/^sug-[0-9]{3}$/),
  })
  .strict();
const DraftTargetBulletV2 = z
  .object({ kind: z.literal("bullet"), factId: Key })
  .strict();

export const Step2DraftOperationV2 = z.discriminatedUnion("op", [
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
        DraftTargetSuggestionV2,
        DraftTargetBulletV2,
      ]),
      text: z.string().min(1).max(2000),
    })
    .strict(),
]);
export type Step2DraftOperationV2 = z.infer<typeof Step2DraftOperationV2>;

/**
 * Draft v2 keeps the v1 operation shapes and replaces `summarySource`
 * with `summaryOrigin`: the origin is always named (master or one
 * angle) so anchor retention survives edits. Whether the saved text
 * is edited is derived server-side by exact-text comparison — the
 * client cannot declare it.
 */
export const Step2SummaryOrigin = z.enum(["master", "angle-1", "angle-2"]);
export type Step2SummaryOrigin = z.infer<typeof Step2SummaryOrigin>;

export const Step2DraftV2 = z
  .object({
    schemaVersion: z.literal(STEP2_CORRECTION_VERSIONS.draft),
    planId: Id,
    planHash: Hash,
    summaryText: z.string().max(4000),
    summaryOrigin: Step2SummaryOrigin,
    operations: z.array(Step2DraftOperationV2).max(50),
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
export type Step2DraftV2 = z.infer<typeof Step2DraftV2>;

/* ------------------------------------------------------------------ */
/* Segment origins, verdicts, and the frozen provenance manifest       */
/* ------------------------------------------------------------------ */

/** Immutable origin identity retained for every included segment. */
export const Step2SegmentOriginV2 = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("master-summary") }).strict(),
  z.object({ kind: z.literal("master-bullet"), factId: Key }).strict(),
  z.object({ kind: z.literal("angle"), angleId: z.string().regex(/^angle-[12]$/) }).strict(),
  z
    .object({
      kind: z.literal("suggestion"),
      suggestionId: z.string().regex(/^sug-[0-9]{3}$/),
    })
    .strict(),
]);
export type Step2SegmentOriginV2 = z.infer<typeof Step2SegmentOriginV2>;

export const Step2StructuralV2 = z
  .object({
    ok: z.boolean(),
    reason: z
      .enum([
        "UNKNOWN_ORIGIN",
        "INVALID_ANCHOR",
        "PRIORITY_LINK_MISSING",
        "FOREIGN_PRIORITY",
        "UNKNOWN_ROLE",
        "FOREIGN_ROLE",
        "UNUSABLE_SUGGESTION",
        "FOREIGN_EMPLOYER",
        "MIXED_OWNERSHIP",
        "PROVIDER_ROLE_INELIGIBLE",
        "CHRONOLOGY",
      ])
      .nullable(),
  })
  .strict()
  .superRefine((structural, ctx) => {
    if (structural.ok === (structural.reason !== null)) {
      ctx.addIssue({
        code: "custom",
        message: "a blocking structural result names its reason",
        path: ["reason"],
      });
    }
  });
export type Step2StructuralV2 = z.infer<typeof Step2StructuralV2>;

/**
 * Verdict v2: provenance (never blocking) is separate from the
 * structural result (blocking). Anchors provide lineage and review
 * context — never proof that arbitrary prose is entailed. `match`
 * records the equality/derivation outcome for audit continuity with
 * v1 verdicts.
 */
export const Step2SegmentVerdictV2 = z
  .object({
    segmentId: z.string().min(1).max(64),
    kind: z.enum(["summary", "bullet"]),
    roleId: Key.nullable(),
    origin: Step2SegmentOriginV2,
    anchorFactIds: z.array(Key).max(100),
    priorityIds: z.array(Hash).max(20),
    textHash: Hash,
    normalizedHash: Hash,
    provenance: Step2Provenance,
    structural: Step2StructuralV2,
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

export const Step2ProvenanceCounts = z
  .object({
    verifiedSource: z.int().nonnegative(),
    userAcceptedAi: z.int().nonnegative(),
    userEdited: z.int().nonnegative(),
  })
  .strict();
export type Step2ProvenanceCounts = z.infer<typeof Step2ProvenanceCounts>;

export const Step2ValidationV2 = z
  .object({
    schemaVersion: z.literal(STEP2_CORRECTION_VERSIONS.validation),
    policyVersion: z.literal(STEP2_CLAIMS_POLICY_V2),
    planId: Id,
    planHash: Hash,
    draftHash: Hash,
    segments: z.array(Step2SegmentVerdictV2).max(60),
    provenanceCounts: Step2ProvenanceCounts,
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
  .strict()
  .superRefine((validation, ctx) => {
    const counts = { verifiedSource: 0, userAcceptedAi: 0, userEdited: 0 };
    for (const segment of validation.segments) {
      if (segment.provenance === "VERIFIED_SOURCE") {
        counts.verifiedSource += 1;
      } else if (segment.provenance === "USER_ACCEPTED_AI") {
        counts.userAcceptedAi += 1;
      } else {
        counts.userEdited += 1;
      }
    }
    if (
      counts.verifiedSource !== validation.provenanceCounts.verifiedSource ||
      counts.userAcceptedAi !== validation.provenanceCounts.userAcceptedAi ||
      counts.userEdited !== validation.provenanceCounts.userEdited
    ) {
      ctx.addIssue({
        code: "custom",
        message: "provenance counts must equal the segment tallies",
        path: ["provenanceCounts"],
      });
    }
  });
export type Step2ValidationV2 = z.infer<typeof Step2ValidationV2>;

/**
 * One frozen manifest entry per included segment. Written once by
 * the G-v2 freeze inside `step2-edited-inputs/v2`; never merged
 * with live workspace state and never supplied by clients.
 */
export const Step2ProvenanceEntryV2 = z
  .object({
    segmentId: z.string().min(1).max(64),
    kind: z.enum(["summary", "bullet"]),
    roleId: Key.nullable(),
    origin: Step2SegmentOriginV2,
    anchorFactIds: z.array(Key).max(100),
    priorityIds: z.array(Hash).max(20),
    textHash: Hash,
    normalizedHash: Hash,
    provenance: Step2Provenance,
    sourceOperationId: Id.nullable(),
  })
  .strict();
export type Step2ProvenanceEntryV2 = z.infer<typeof Step2ProvenanceEntryV2>;

export const Step2EditedInputsV2 = z
  .object({
    schemaVersion: z.literal(STEP2_CORRECTION_VERSIONS.editedInputs),
    planId: Id,
    summaryText: z.string().max(4000),
    summaryOrigin: Step2SummaryOrigin,
    operations: z.array(Step2DraftOperationV2).max(50),
    provenanceManifest: z.array(Step2ProvenanceEntryV2).max(60),
  })
  .strict()
  .superRefine((inputs, ctx) => {
    const ids = inputs.provenanceManifest.map((entry) => entry.segmentId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        message: "manifest segment ids must be unique",
        path: ["provenanceManifest"],
      });
    }
  });
export type Step2EditedInputsV2 = z.infer<typeof Step2EditedInputsV2>;

/** Frozen policy lineage pinned into every correction generation. */
export const Step2PolicyVersionsV2 = z
  .object({
    schemaVersion: z.literal(STEP2_CORRECTION_VERSIONS.policyVersions),
    claims: z.literal(STEP2_CLAIMS_POLICY_V2),
    master: z.literal("step2-master-bullets/1"),
    prompt: z.literal(PREPARE_PROMPT_VERSION_V2),
  })
  .strict();
export type Step2PolicyVersionsV2 = z.infer<typeof Step2PolicyVersionsV2>;

/* ------------------------------------------------------------------ */
/* Workspace v3                                                        */
/* ------------------------------------------------------------------ */

const Note = z.string().trim().min(1).max(4000);

export const WorkspacePutV3 = z
  .object({
    schemaVersion: z.literal(STEP2_CORRECTION_VERSIONS.workspace),
    extractionId: Id.nullable(),
    profileId: Key.nullable(),
    profileVersionId: Id.nullable(),
    requestKind: z.enum(["INITIAL", "NEW_VERSION", "REVISION"]),
    parentVersionId: Id.nullable(),
    revisionNote: Note.nullable(),
    planId: Id.nullable(),
    planHash: Hash.nullable(),
    recommendationHash: Hash.nullable(),
    draft: Step2DraftV2.nullable(),
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
export type WorkspacePutV3 = z.infer<typeof WorkspacePutV3>;

/**
 * Stored v3 bytes: `focus_json` holds a v1 `FocusV1`, a v2
 * `WorkspaceStoredV2`, or this envelope, discriminated by the inner
 * `schemaVersion`. Saving any version replaces the bytes wholesale
 * under the same revision CAS; versions never merge.
 */
export const WorkspaceStoredV3 = z
  .object({
    schemaVersion: z.literal(STEP2_CORRECTION_VERSIONS.workspace),
    planId: Id.nullable(),
    planHash: Hash.nullable(),
    draft: Step2DraftV2.nullable(),
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
export type WorkspaceStoredV3 = z.infer<typeof WorkspaceStoredV3>;

export const WorkspaceViewV3 = z
  .object({
    jobId: Id,
    revision: z.int().positive(),
    draft: WorkspacePutV3,
    recommendations: RecommendationV1.nullable(),
    lastRequestId: Id.nullable(),
    lastSubmittedRevision: z.int().positive().nullable(),
    updatedAt: Time,
  })
  .strict();
export type WorkspaceViewV3 = z.infer<typeof WorkspaceViewV3>;

/* ------------------------------------------------------------------ */
/* Commands, replies, and provider envelopes                           */
/* ------------------------------------------------------------------ */

export const ValidateDraftBodyV2 = z
  .object({
    schemaVersion: z.literal(STEP2_CORRECTION_VERSIONS.validateDraft),
    workspaceRevision: z.int().positive(),
    summaryText: z.string().max(4000),
    summaryOrigin: Step2SummaryOrigin,
    operations: z.array(Step2DraftOperationV2).max(50),
  })
  .strict();
export type ValidateDraftBodyV2 = z.infer<typeof ValidateDraftBodyV2>;

export const ValidateDraftReplyV2 = z
  .object({
    ok: z.literal(true),
    validationId: Id,
    validation: Step2ValidationV2,
  })
  .strict();
export type ValidateDraftReplyV2 = z.infer<typeof ValidateDraftReplyV2>;

/**
 * Plan reply v2: the accepted plan plus the server-derived
 * eligible-role set per suggestion, recomputed on every read from
 * the plan's anchors and the captured payload. Providers never
 * supply these sets and the plan row never stores them.
 */
export const PlanReplyV2 = z
  .object({
    ok: z.literal(true),
    plan: PreparationPlanV2,
    eligibleRoles: z
      .array(
        z
          .object({
            suggestionId: z.string().regex(/^sug-[0-9]{3}$/),
            eligibleRoleIds: z.array(Key).max(50),
          })
          .strict(),
      )
      .max(10),
    planHash: Hash,
    validatedAt: Time,
    supersedesPlanId: Id.nullable(),
  })
  .strict()
  .superRefine((reply, ctx) => {
    const known = new Set(
      reply.plan.suggestions.map((suggestion) => suggestion.suggestionId),
    );
    const seen = new Set<string>();
    reply.eligibleRoles.forEach((entry, index) => {
      if (seen.has(entry.suggestionId)) {
        ctx.addIssue({
          code: "custom",
          message: "eligible-role entries must be unique",
          path: ["eligibleRoles", index],
        });
      }
      seen.add(entry.suggestionId);
      if (!known.has(entry.suggestionId)) {
        ctx.addIssue({
          code: "custom",
          message: "eligible-role entry names no plan suggestion",
          path: ["eligibleRoles", index],
        });
      }
      if (new Set(entry.eligibleRoleIds).size !== entry.eligibleRoleIds.length) {
        ctx.addIssue({
          code: "custom",
          message: "eligible role ids must be unique",
          path: ["eligibleRoles", index, "eligibleRoleIds"],
        });
      }
    });
    if (seen.size !== known.size) {
      ctx.addIssue({
        code: "custom",
        message: "every plan suggestion carries its eligible-role set",
        path: ["eligibleRoles"],
      });
    }
  });
export type PlanReplyV2 = z.infer<typeof PlanReplyV2>;

export const PreparationInputV2 = z
  .object({
    schemaVersion: z.literal(STEP2_CORRECTION_VERSIONS.preparationInput),
    promptVersion: z.literal(PREPARE_PROMPT_VERSION_V2),
    jobId: z.string().min(1),
    jobTitle: z.string(),
    company: z.string(),
    extractionId: Id,
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
        priorities: z.int(),
        suggestions: z.int(),
        angles: z.int(),
      })
      .strict(),
  })
  .strict();
export type PreparationInputV2 = z.infer<typeof PreparationInputV2>;

/**
 * Provider proposal v2 (provider trust boundary): v1 fields plus
 * mandatory same-plan priority links on every angle and suggestion.
 * Strict: `provenance`, `verified`, `accepted`, `userAuthored`,
 * `eligibleRoleIds`, `score`, `coverage`, `actor`, `now`, and paths
 * are rejected before any semantic check runs.
 */
export const PreparationProposalV2 = z
  .object({
    schemaVersion: z.literal(STEP2_CORRECTION_VERSIONS.preparationProposal),
    jdSnapshotId: z.string().min(1),
    candidateSnapshotId: z.string().min(1),
    priorities: z
      .array(
        z
          .object({
            quote: PlanQuoteV2,
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
            priorityIds: z.array(Hash).min(1).max(20),
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
            priorityIds: z.array(Hash).min(1).max(20),
          })
          .strict(),
      )
      .max(10),
    rationale: z.string().max(2000),
  })
  .strict();
export type PreparationProposalV2 = z.infer<typeof PreparationProposalV2>;

/* ------------------------------------------------------------------ */
/* Eligible-role derivation (server-side, never stored by providers)   */
/* ------------------------------------------------------------------ */

export type EligibleRoleOwnership =
  | "single"
  | "transferable"
  | "mixed"
  | "unknown";

export interface EligibleRoleDerivation {
  eligibleRoleIds: string[];
  ownership: EligibleRoleOwnership;
}

/**
 * Derive the roles a suggestion may target from its cited anchors:
 * employment-owned facts restrict targeting to the employment(s)
 * owning ALL such facts; purely transferable anchors may target any
 * employment; mixed or ambiguous ownership fails closed with no
 * eligible role. Unknown fact ids fail closed as `unknown` — the
 * caller reports `INVALID_ANCHOR` before consulting eligibility.
 */
export function deriveEligibleRoles(input: {
  citedFactIds: string[];
  employmentByFactId: ReadonlyMap<string, string | null>;
  employmentIds: string[];
}): EligibleRoleDerivation {
  const owned: string[] = [];
  for (const factId of input.citedFactIds) {
    if (!input.employmentByFactId.has(factId)) {
      return { eligibleRoleIds: [], ownership: "unknown" };
    }
    const employmentId = input.employmentByFactId.get(factId);
    if (employmentId !== null && employmentId !== undefined) {
      owned.push(employmentId);
    }
  }
  if (owned.length === 0) {
    return {
      eligibleRoleIds: [...input.employmentIds],
      ownership: "transferable",
    };
  }
  const distinct = [...new Set(owned)];
  if (
    distinct.length === 1 &&
    input.employmentIds.includes(distinct[0] as string)
  ) {
    return { eligibleRoleIds: [distinct[0] as string], ownership: "single" };
  }
  return { eligibleRoleIds: [], ownership: "mixed" };
}

/* ------------------------------------------------------------------ */
/* Segment derivation (selected-summary-only anchors)                  */
/* ------------------------------------------------------------------ */

export interface CorrectionMasterBullet {
  roleId: string;
  factId: string;
  text: string;
}

export interface CorrectionDerivedSegment {
  segmentId: string;
  kind: "summary" | "bullet";
  roleId: string | null;
  origin: Step2SegmentOriginV2;
  /** Lineage anchors from the chosen origin only — never a plan union. */
  anchorFactIds: string[];
  priorityIds: string[];
  text: string;
  /** True when a saved user operation reworded the origin text. */
  userEdited: boolean;
  sourceOperationId: string | null;
}

function angleTextOf(
  plan: PreparationPlanV2,
  origin: Step2SummaryOrigin,
): { text: string; factIds: string[]; priorityIds: string[] } | null {
  if (origin === "master") {
    return null;
  }
  const angle = plan.positioning.angles.find((entry) => entry.angleId === origin);
  if (angle === undefined) {
    return null;
  }
  return {
    text: angle.summaryText,
    factIds: [...angle.factIds],
    priorityIds: [...angle.priorityIds],
  };
}

/**
 * Derive validation segments from exact v2 draft bytes. The summary
 * cites ONLY its chosen origin's anchors (master: none — profile
 * activation is the lineage; angle: that angle's fact ids). The v1
 * union of all unselected suggestion/angle facts is forbidden: it
 * let unselected proposals launder citations into the summary.
 *
 * Unknown plan references yield no bullet segment here — W-v3
 * rejects them on save, and the generation applier fails closed on
 * them. `exclude` yields no segment: excluded content never blocks
 * and never renders.
 */
export function deriveCorrectionSegments(input: {
  plan: PreparationPlanV2;
  master: CorrectionMasterBullet[];
  masterSummary: string;
  summaryText: string;
  summaryOrigin: Step2SummaryOrigin;
  operations: Step2DraftOperationV2[];
}): CorrectionDerivedSegment[] {
  const suggestionsById = new Map(
    input.plan.suggestions.map((suggestion) => [
      suggestion.suggestionId,
      suggestion,
    ]),
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
  const segments: CorrectionDerivedSegment[] = [];
  if (input.summaryText !== "") {
    if (input.summaryOrigin === "master") {
      segments.push({
        segmentId: "summary",
        kind: "summary",
        roleId: null,
        origin: { kind: "master-summary" },
        anchorFactIds: [],
        priorityIds: [],
        text: input.summaryText,
        userEdited:
          canonicalText(input.summaryText) !==
          canonicalText(input.masterSummary),
        sourceOperationId: null,
      });
    } else {
      const angle = angleTextOf(input.plan, input.summaryOrigin);
      if (angle !== null) {
        segments.push({
          segmentId: "summary",
          kind: "summary",
          roleId: null,
          origin: { kind: "angle", angleId: input.summaryOrigin },
          anchorFactIds: angle.factIds,
          priorityIds: angle.priorityIds,
          text: input.summaryText,
          userEdited:
            canonicalText(input.summaryText) !== canonicalText(angle.text),
          sourceOperationId: null,
        });
      }
    }
  }
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
        origin: {
          kind: "suggestion",
          suggestionId: op.suggestionId,
        },
        anchorFactIds: [...suggestion.factIds],
        priorityIds: [...suggestion.priorityIds],
        text: op.editedText ?? suggestion.text,
        userEdited:
          op.editedText !== null &&
          canonicalText(op.editedText) !== canonicalText(suggestion.text),
        sourceOperationId: op.operationId,
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
          origin: {
            kind: "suggestion",
            suggestionId: op.suggestionId,
          },
          anchorFactIds: [...suggestion.factIds],
          priorityIds: [...suggestion.priorityIds],
          text: suggestion.text,
          userEdited: false,
          sourceOperationId: op.operationId,
        });
      } else if (op.editedText !== null) {
        segments.push({
          segmentId: `op:${op.operationId}`,
          kind: "bullet",
          roleId: op.roleId,
          origin: { kind: "master-bullet", factId: op.targetFactId },
          anchorFactIds: [op.targetFactId],
          priorityIds: [],
          text: op.editedText,
          userEdited: true,
          sourceOperationId: op.operationId,
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
        roleId:
          instanceRoleBySuggestion.get(op.target.suggestionId) ?? null,
        origin: {
          kind: "suggestion",
          suggestionId: op.target.suggestionId,
        },
        anchorFactIds: [...suggestion.factIds],
        priorityIds: [...suggestion.priorityIds],
        text: op.text,
        userEdited:
          canonicalText(op.text) !== canonicalText(suggestion.text),
        sourceOperationId: op.operationId,
      });
    } else {
      const target = op.target;
      if (target.kind !== "bullet") {
        continue;
      }
      const bullet = input.master.find(
        (entry) => entry.factId === target.factId,
      );
      segments.push({
        segmentId: `op:${op.operationId}`,
        kind: "bullet",
        roleId: bulletRoleByFact.get(target.factId) ?? null,
        origin: { kind: "master-bullet", factId: target.factId },
        anchorFactIds: [target.factId],
        priorityIds: [],
        text: op.text,
        userEdited:
          bullet === undefined ||
          canonicalText(op.text) !== canonicalText(bullet.text),
        sourceOperationId: op.operationId,
      });
    }
  }
  return segments;
}

/* ------------------------------------------------------------------ */
/* Provenance derivation (exhaustive three-way table)                  */
/* ------------------------------------------------------------------ */

/**
 * Derive one segment's provenance. Exhaustive and ordered:
 * untouched master text with intact lineage is verified source;
 * untouched usable AI text is user-accepted AI; anything else —
 * including any saved text change — is a user edit. User edits are
 * generatable verbatim and never counted as machine-verified.
 *
 * `lineageIntact` means every anchor is approved and owned by the
 * bound profile version (master-summary segments pass true when the
 * captured binding verifies — activation is their lineage).
 * `originUsable` applies to angle/suggestion origins only.
 */
export function deriveSegmentProvenance(input: {
  origin: Step2SegmentOriginV2;
  originText: string;
  text: string;
  userEdited: boolean;
  originUsable: boolean;
  lineageIntact: boolean;
}): Step2Provenance {
  const unchanged =
    input.userEdited === false &&
    canonicalText(input.text) === canonicalText(input.originText);
  if (unchanged && input.lineageIntact) {
    if (
      input.origin.kind === "master-summary" ||
      input.origin.kind === "master-bullet"
    ) {
      return "VERIFIED_SOURCE";
    }
    if (input.originUsable) {
      return "USER_ACCEPTED_AI";
    }
  }
  return "USER_EDITED";
}

/* ------------------------------------------------------------------ */
/* One Generate transition (UI/server shared vocabulary)               */
/* ------------------------------------------------------------------ */

/**
 * Step 2 has exactly one primary exit. Ordered, indivisible from
 * the user's perspective: flush → resolve → freeze → submit →
 * Step 3. Navigation-only Continue semantics are forbidden.
 */
export const GENERATE_TRANSITION_STEPS = [
  "flush",
  "resolve",
  "freeze",
  "submit",
  "follow",
] as const;
export type GenerateTransitionStep =
  (typeof GENERATE_TRANSITION_STEPS)[number];

/** Size budgets carried forward unchanged from the S2-A contract. */
export const STEP2_CORRECTION_BUDGETS = {
  operations: 50,
  segments: 60,
  planJsonBytes: 65536,
  verdictJsonBytes: 65536,
  editedInputsBytes: 65536,
  priorities: 20,
  priorityLinks: 20,
  suggestions: 10,
  angles: 2,
  featured: 5,
} as const;
