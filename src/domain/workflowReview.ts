import { z } from "zod";
import { EntityId as Id, IsoUtcDateTime as Time, Sha256Hex as Hash } from "./fields";
import { Step2DraftOperationV2, Step2Provenance } from "./step2Correction";
import { Step2DraftOperationV1 } from "./step2";
import { AssessmentV1 } from "./tailoringWorkspace";

/**
 * Exact-version review read model (WO-1.3-G). Strict schemas for the
 * `workflowReview` extension served alongside the v1 review view.
 *
 * Every field derives from immutable frozen rows (version, request,
 * request inputs, validation, plan, assessment, artifacts) — never
 * from the mutable workspace, the active profile pointer, the
 * browser, or provider assertions. Legacy rows without frozen
 * inputs validate with explicit nulls/empties ("not assessed" /
 * "baseline unavailable" in the UI); the server never substitutes
 * current master bytes for a missing frozen baseline.
 *
 * Pure domain module: Zod plus sibling imports only.
 */

export const WORKFLOW_REVIEW_V2_SCHEMA_VERSION = "workflow-review/v2";

const Key = z.string().min(1).max(128);

export const WorkflowReviewFormat = z.enum(["focus", "edited-plan", "legacy"]);
export type WorkflowReviewFormat = z.infer<typeof WorkflowReviewFormat>;

export const WorkflowReviewSummaryOrigin = z.enum([
  "master",
  "angle-1",
  "angle-2",
  "edited",
  "focus",
]);
export type WorkflowReviewSummaryOrigin = z.infer<typeof WorkflowReviewSummaryOrigin>;

export const WorkflowReviewOperation = z
  .object({
    operationId: Id,
    op: z.enum(["add", "replace", "exclude", "edit"]),
    /** Compact server-built description (e.g. "Add sug-001 to emp-harbor (edited)"). */
    detail: z.string().min(1).max(280),
    /**
     * Verbatim frozen op bytes (v1 or v2 shape). Step 4 restores
     * these exact bytes into the revision draft — never rebuilt,
     * never reinterpreted.
     */
    raw: z.union([Step2DraftOperationV2, Step2DraftOperationV1]),
  })
  .strict()
  .superRefine((op, ctx) => {
    if (op.raw.operationId !== op.operationId || op.raw.op !== op.op) {
      ctx.addIssue({
        code: "custom",
        path: ["raw"],
        message: "raw op must match the operation envelope",
      });
    }
  });
export type WorkflowReviewOperation = z.infer<typeof WorkflowReviewOperation>;

export const WorkflowReviewSegment = z
  .object({
    segmentId: z.string().min(1).max(64),
    kind: z.enum(["summary", "bullet"]),
    roleId: Key.nullable(),
    /** Exact frozen segment text (verbatim bytes). */
    text: z.string().max(4000),
    textHash: Hash,
    /**
     * Server-derived provenance. "UNLABELED" marks pre-correction
     * rows (claims/1 verdicts): included under the contemporary
     * strict gate, never relabeled as a correction category and
     * never described as verified.
     */
    provenance: z.enum([
      "VERIFIED_SOURCE",
      "USER_ACCEPTED_AI",
      "USER_EDITED",
      "UNLABELED",
    ]),
    sourceOperationId: Id.nullable(),
    anchorFactIds: z.array(Key).max(100),
    priorityIds: z.array(Hash).max(20),
  })
  .strict();
export type WorkflowReviewSegment = z.infer<typeof WorkflowReviewSegment>;

/** Re-exported for review builders (no new category invented here). */
export type { Step2Provenance };

const WorkflowReviewPriority = z
  .object({
    id: Hash,
    quote: z.string().min(1).max(512),
    support: z.enum(["supported", "related", "gap"]),
  })
  .strict();

export const WorkflowReviewFocus = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("focus"),
      selectedPhraseTexts: z.array(z.string().min(1).max(512)).max(20),
      themeId: Key.nullable(),
      mappingsCount: z.int().nonnegative(),
      guidancePresent: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("edited-plan"),
      priorities: z.array(WorkflowReviewPriority).max(20),
      featuredPriorityIds: z.array(Hash).max(5),
    })
    .strict(),
  z.object({ kind: z.literal("legacy") }).strict(),
]);
export type WorkflowReviewFocus = z.infer<typeof WorkflowReviewFocus>;

export const WorkflowReviewInsightKind = z.enum([
  "keyword-coverage",
  "requirement-coverage",
  "document-checks",
  "evidence-integrity",
  "requirement-gap",
  "provenance-note",
  "length-advisory",
]);
export type WorkflowReviewInsightKind = z.infer<typeof WorkflowReviewInsightKind>;

export const WorkflowReviewInsight = z
  .object({
    /** Stable deterministic id (kind plus record key). */
    id: z.string().min(1).max(128),
    kind: WorkflowReviewInsightKind,
    /** Fixed-template copy; never calls user text verified/gained. */
    text: z.string().min(1).max(500),
    citations: z
      .object({
        priorityIds: z.array(Hash).max(20),
        requirementIds: z.array(Key).max(100),
        segmentIds: z.array(z.string().min(1).max(64)).max(100),
        checkIds: z.array(Key).max(10),
      })
      .strict(),
  })
  .strict();
export type WorkflowReviewInsight = z.infer<typeof WorkflowReviewInsight>;

export const WorkflowReviewAllowedActions = z
  .object({
    approve: z.boolean(),
    revise: z.boolean(),
    decline: z.boolean(),
    newVersion: z.boolean(),
    /** First blocking reason, or null when every action is available. */
    reason: z.string().max(280).nullable(),
  })
  .strict();
export type WorkflowReviewAllowedActions = z.infer<typeof WorkflowReviewAllowedActions>;

export const WorkflowReviewMarkers = z
  .object({
    /** This version is the job's latest publication (active pointer). */
    latestPublished: z.boolean(),
    /** This version is the job's selected approved version. */
    selectedApproved: z.boolean(),
    /** A human recorded an application against this exact version. */
    isApplicationVersion: z.boolean(),
    appliedAt: Time.nullable(),
  })
  .strict();
export type WorkflowReviewMarkers = z.infer<typeof WorkflowReviewMarkers>;

export const WorkflowReviewTailoredTextStatus = z.enum([
  "ok",
  "unchecked",
  "missing",
  "mismatch",
]);
export type WorkflowReviewTailoredTextStatus = z.infer<
  typeof WorkflowReviewTailoredTextStatus
>;

export const WorkflowReviewV2 = z
  .object({
    schemaVersion: z.literal(WORKFLOW_REVIEW_V2_SCHEMA_VERSION),
    format: WorkflowReviewFormat,
    version: z
      .object({
        id: Id,
        version: z.int().positive(),
        reviewState: z.string().min(1).max(32),
        parentVersionId: Id.nullable(),
        contentHash: Hash,
        createdAt: Time,
      })
      .strict(),
    request: z
      .object({
        id: Id,
        kind: z.enum(["INITIAL", "NEW_VERSION", "REVISION"]),
        parentVersionId: Id.nullable(),
        revisionNote: z.string().max(4000).nullable(),
      })
      .strict()
      .nullable(),
    /** Frozen profile binding (from the request — never the active pointer). */
    profile: z
      .object({
        profileId: Key,
        profileVersionId: Id,
        profileVersionNumber: z.int().positive().nullable(),
      })
      .strict()
      .nullable(),
    /** Parent version identity (exact id + number, or null for v1). */
    parent: z
      .object({ id: Id, version: z.int().positive() })
      .strict()
      .nullable(),
    /** Frozen master projection; null renders "baseline unavailable". */
    master: z
      .object({
        text: z.string().max(262144),
        hash: Hash,
      })
      .strict()
      .nullable(),
    summaryOrigin: WorkflowReviewSummaryOrigin.nullable(),
    /**
     * Frozen summary text (edited-plan only; null otherwise).
     * Restored verbatim into revision drafts alongside `operations`.
     */
    summaryText: z.string().max(4000).nullable(),
    /** Ordered frozen edited operations (edited-plan only). */
    operations: z.array(WorkflowReviewOperation).max(50),
    validation: z
      .object({
        id: Id,
        policyVersion: z.string().min(1).max(64),
        planId: Id.nullable(),
        planHash: Hash.nullable(),
        draftHash: Hash.nullable(),
      })
      .strict()
      .nullable(),
    /** Version-row lineage (template/ranker/policy/config/render). */
    policies: z
      .object({
        templateId: z.string().min(1).max(200),
        templateVersion: z.string().min(1).max(64),
        rankerVersion: z.string().min(1).max(64),
        policyVersion: z.string().min(1).max(64),
        configVersion: z.string().min(1).max(64),
        renderSchemaVersion: z.string().min(1).max(64),
      })
      .strict(),
    /** Frozen edited segments with per-segment provenance. */
    segments: z.array(WorkflowReviewSegment).max(200),
    /** Exact master bullet texts removed by explicit exclude ops. */
    excludedTexts: z.array(z.string().min(1).max(2000)).max(50),
    focus: WorkflowReviewFocus,
    /** Null renders "not assessed" (never 0% or 100%). */
    assessment: AssessmentV1.nullable(),
    assessmentLineage: z
      .object({
        requestId: Id,
        validationId: Id.nullable(),
        masterHash: Hash,
        contentHash: Hash,
      })
      .strict()
      .nullable(),
    insights: z.array(WorkflowReviewInsight).max(40),
    allowedActions: WorkflowReviewAllowedActions,
    markers: WorkflowReviewMarkers,
    /** Exact canonical markdown bytes ("" unless status is ok). */
    tailoredText: z.string().max(1048576),
    tailoredTextStatus: WorkflowReviewTailoredTextStatus,
  })
  .strict()
  .superRefine((review, ctx) => {
    const ids = review.operations.map((op) => op.operationId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        path: ["operations"],
        message: "operation ids must be unique",
      });
    }
    const segmentIds = review.segments.map((segment) => segment.segmentId);
    if (new Set(segmentIds).size !== segmentIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["segments"],
        message: "segment ids must be unique",
      });
    }
    if (
      review.tailoredTextStatus === "ok" &&
      review.tailoredText.trim() === ""
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["tailoredText"],
        message: "ok tailored text must be non-blank",
      });
    }
    if (
      review.tailoredTextStatus !== "ok" &&
      review.tailoredText !== ""
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["tailoredText"],
        message: "unavailable tailored text must be empty",
      });
    }
  });
export type WorkflowReviewV2 = z.infer<typeof WorkflowReviewV2>;
