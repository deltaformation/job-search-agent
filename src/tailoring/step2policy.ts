import { canonicalJson, canonicalText } from "../domain/canonical";
import {
  PREPARE_PROMPT_VERSION,
  STEP2_CLAIMS_POLICY,
  STEP2_MASTER_PROJECTION,
  STEP2_POLICY_VERSIONS_VERSION,
  checkStep2Budgets,
  masterBulletsByRole,
  type IntakeBindingV1,
  type PreparationPlanV1,
  type Step2DerivedSegment,
  type Step2DraftOperationV1,
  type Step2DraftV1,
  type Step2PolicyVersionsV1,
  type Step2ValidationV1,
} from "../domain/step2";
import {
  claimKey,
  namedCompanies,
  novelNumbers,
  STEP2_REASONS,
  type Step2Reason,
  type Step2SegmentInput,
  type Step2SnapshotFact,
  type ValidateStep2SegmentsInput,
} from "../domain/step2Claims";
import { sha256HexUtf8 } from "./hash";

/**
 * WO-1.3-S2-A executable policy: §2 digests, §7 quote verification,
 * and the `step2-claims/1` hashing verdict computation.
 *
 * Hashes live in tailoring (like `phraseIdFor` in requestsV3) because
 * the domain purity guard restricts `src/domain` to Zod plus sibling
 * modules. Pure: no database, clock, provider, or filesystem access.
 * `supported` requires normalized text equality with approved
 * content or an allowlisted derivation manifest; cited fact ids,
 * token overlap, and any model verdict are never sufficient.
 */

/* ------------------------------------------------------------------ */
/* §2 digests                                                          */
/* ------------------------------------------------------------------ */

export interface EvidenceDigestFact {
  factId: string;
  statement: string;
  employmentId: string | null;
}

export function evidenceHashFor(input: {
  profileVersionId: string;
  payloadHash: string;
  approved: EvidenceDigestFact[];
}): string {
  const approved = [...input.approved]
    .map((fact) => ({
      factId: fact.factId,
      statement: fact.statement,
      employmentId: fact.employmentId,
    }))
    .sort((a, b) => (a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0));
  return sha256HexUtf8(
    canonicalJson({
      profileVersionId: input.profileVersionId,
      payloadHash: input.payloadHash,
      approved,
    }),
  );
}

export function bindingHashFor(binding: IntakeBindingV1): string {
  return sha256HexUtf8(canonicalJson(binding));
}

export function masterProjectionHashFor(
  payload: Parameters<typeof masterBulletsByRole>[0],
): string {
  return sha256HexUtf8(canonicalJson(masterBulletsByRole(payload)));
}

export function planHashFor(plan: PreparationPlanV1): string {
  return sha256HexUtf8(canonicalJson(plan));
}

export function draftHashFor(draft: Step2DraftV1): string {
  return sha256HexUtf8(
    canonicalJson({
      planId: draft.planId,
      planHash: draft.planHash,
      summaryText: draft.summaryText,
      summarySource: draft.summarySource,
      operations: draft.operations,
    }),
  );
}

export function segmentTextHashFor(text: string): string {
  return sha256HexUtf8(text);
}

export function segmentNormalizedHashFor(text: string): string {
  return sha256HexUtf8(canonicalText(text));
}

export function prepareOperationHashFor(input: {
  jobId: string;
  operationId: string;
  observedRowVersion: number;
  profileId: string | null;
}): string {
  return sha256HexUtf8(canonicalJson(input));
}

export const STEP2_WORKFLOW_INPUT_SCHEMA_VERSION = "step2-request-input/v1";

/** Frozen policy lineage pinned into every edited-plan generation. */
export function step2GenerationPolicies(): Step2PolicyVersionsV1 {
  return {
    schemaVersion: STEP2_POLICY_VERSIONS_VERSION,
    claims: STEP2_CLAIMS_POLICY,
    master: STEP2_MASTER_PROJECTION,
    prompt: PREPARE_PROMPT_VERSION,
  };
}

export interface Step2WorkflowInput {
  workspaceRevision: number;
  planId: string;
  planHash: string;
  draftHash: string;
  /** Exact verdict row the gate bound (content-addressed, unambiguous). */
  validationId: string;
  candidateSnapshotId: string;
  masterText: string;
  masterTextHash: string;
  projectionVersion: "master-text/1";
  policies: Step2PolicyVersionsV1;
}

/**
 * `step2-request-input/v1`: the v3 queue payload's `inputHash` for
 * edited-plan requests. Same role as `hashWorkflowRequestInput`
 * for v1 focus requests, but over the frozen plan/draft/verdict
 * binding — a new digest name, never a reinterpretation of v1
 * bytes (contracts §12). G and the worker recompute identically.
 */
export function hashStep2WorkflowInput(input: Step2WorkflowInput): string {
  return sha256HexUtf8(
    canonicalJson({
      schemaVersion: STEP2_WORKFLOW_INPUT_SCHEMA_VERSION,
      workspaceRevision: input.workspaceRevision,
      planId: input.planId,
      planHash: input.planHash,
      draftHash: input.draftHash,
      validationId: input.validationId,
      candidateSnapshotId: input.candidateSnapshotId,
      masterText: input.masterText,
      masterTextHash: input.masterTextHash,
      projectionVersion: input.projectionVersion,
      policies: input.policies,
    }),
  );
}

/** Recompute a draft hash for race comparison (S2-D generation gate). */
export function draftHashMatches(
  expected: string,
  draft: {
    planId: string;
    planHash: string;
    summaryText: string;
    summarySource: "master" | "angle-1" | "angle-2" | "edited";
    operations: Step2DraftOperationV1[];
  },
): boolean {
  return (
    draftHashFor({
      schemaVersion: "step2-draft/v1",
      planId: draft.planId,
      planHash: draft.planHash,
      summaryText: draft.summaryText,
      summarySource: draft.summarySource,
      operations: draft.operations,
    }) === expected
  );
}

export interface PlanQuoteCheck {
  priorityId: string;
  ok: boolean;
  reason: string | null;
}

/**
 * Verify every priority quote selects its exact UTF-8 byte range in
 * the canonical JD. Failures drop the priority with reason; the plan
 * still accepts when proposal validation otherwise passes.
 */
export function verifyPlanQuotes(
  plan: PreparationPlanV1,
  canonicalJdText: string,
): PlanQuoteCheck[] {
  const bytes = Buffer.from(canonicalJdText, "utf8");
  return plan.priorities.map((priority) => {
    const { startByte, endByte, text } = priority.quote;
    if (
      !Number.isInteger(startByte) ||
      !Number.isInteger(endByte) ||
      endByte <= startByte ||
      endByte > bytes.length
    ) {
      return {
        priorityId: priority.priorityId,
        ok: false,
        reason: "QUOTE_RANGE_INVALID",
      };
    }
    const slice = bytes.subarray(startByte, endByte);
    const decoded = slice.toString("utf8");
    if (
      decoded !== text ||
      Buffer.from(decoded, "utf8").equals(slice) === false
    ) {
      return {
        priorityId: priority.priorityId,
        ok: false,
        reason: "QUOTE_BYTES_MISMATCH",
      };
    }
    return { priorityId: priority.priorityId, ok: true, reason: null };
  });
}

/* ------------------------------------------------------------------ */
/* §7.1 segment verdicts                                               */
/* ------------------------------------------------------------------ */

interface SegmentVerdict {
  segmentId: string;
  kind: "summary" | "bullet";
  roleId: string | null;
  textHash: string;
  normalizedHash: string;
  verdict: "supported" | "needs-evidence";
  factIds: string[];
  match: "exact-fact" | "exact-plan" | "exact-master" | "derivation" | "none";
  reason: string | null;
}

function verdictFor(
  segment: Step2SegmentInput,
  input: ValidateStep2SegmentsInput,
  factsById: Map<string, Step2SnapshotFact>,
): SegmentVerdict {
  const base = {
    segmentId: segment.segmentId,
    kind: segment.kind,
    roleId: segment.roleId,
    textHash: segmentTextHashFor(segment.text),
    normalizedHash: segmentNormalizedHashFor(segment.text),
  };
  const needs = (
    reason: Step2Reason,
    factIds: string[] = [],
  ): SegmentVerdict => ({
    ...base,
    verdict: "needs-evidence",
    factIds,
    match: "none",
    reason,
  });

  // Rule 1: chronology over recorded version/plan lineage.
  if (
    input.versionCreatedAt > input.planAcceptedAt ||
    input.planAcceptedAt > input.now
  ) {
    return needs(STEP2_REASONS.CHRONOLOGY, [...segment.citedFactIds]);
  }
  for (const factId of segment.citedFactIds) {
    const fact = factsById.get(factId);
    if (fact === undefined) {
      return needs(STEP2_REASONS.UNKNOWN_FACT, [...segment.citedFactIds]);
    }
    if (fact.verification !== "APPROVED") {
      return needs(STEP2_REASONS.FACT_NOT_APPROVED, [...segment.citedFactIds]);
    }
    if (fact.profileVersionId !== input.boundProfileVersionId) {
      return needs(STEP2_REASONS.FOREIGN_FACT, [...segment.citedFactIds]);
    }
  }
  if (segment.citedFactIds.length === 0) {
    return needs(STEP2_REASONS.UNKNOWN_FACT, []);
  }

  // Rule 3: role-owned facts never cross employers.
  const roleEmployment =
    segment.roleId === null || segment.roleId === "" ? null : segment.roleId;
  for (const factId of segment.citedFactIds) {
    const fact = factsById.get(factId) as Step2SnapshotFact;
    if (
      fact.employmentId !== null &&
      roleEmployment !== null &&
      fact.employmentId !== roleEmployment
    ) {
      return needs(STEP2_REASONS.FOREIGN_ROLE_FACT, [...segment.citedFactIds]);
    }
  }

  // Rule 4: exact normalized equality. Approved content carries
  // its entities, so equality precedes the novelty diagnostics.
  const key = claimKey(segment.text);
  for (const factId of segment.citedFactIds) {
    const fact = factsById.get(factId) as Step2SnapshotFact;
    if (claimKey(fact.statement) === key) {
      return {
        ...base,
        verdict: "supported",
        factIds: [factId],
        match: "exact-fact",
        reason: null,
      };
    }
  }
  for (const planText of input.planTexts) {
    if (claimKey(planText.text) === key) {
      return {
        ...base,
        verdict: "supported",
        factIds: [...segment.citedFactIds],
        match: "exact-plan",
        reason: null,
      };
    }
  }
  if (segment.kind === "bullet") {
    for (const bullet of input.master) {
      if (
        (roleEmployment === null || bullet.roleId === roleEmployment) &&
        claimKey(bullet.text) === key
      ) {
        return {
          ...base,
          verdict: "supported",
          factIds: [...segment.citedFactIds],
          match: "exact-master",
          reason: null,
        };
      }
    }
  }

  // Rule 4b: allowlisted derivation manifest equality.
  const manifest = segment.derivation;
  if (
    manifest !== undefined &&
    manifest.finalText === segment.text &&
    manifest.factIds.length === segment.citedFactIds.length &&
    manifest.factIds.every((id) => segment.citedFactIds.includes(id))
  ) {
    return {
      ...base,
      verdict: "supported",
      factIds: [...segment.citedFactIds],
      match: "derivation",
      reason: null,
    };
  }

  // Rule 5: entity-novelty failures (necessary conditions only).
  const citedTexts: string[] = [];
  for (const factId of segment.citedFactIds) {
    const fact = factsById.get(factId) as Step2SnapshotFact;
    citedTexts.push(fact.statement, ...(fact.metrics ?? []));
  }
  if (novelNumbers(segment.text, citedTexts).length > 0) {
    return needs(STEP2_REASONS.NEW_METRIC, [...segment.citedFactIds]);
  }
  const named = namedCompanies(segment.text, input.employments);
  if (named.length > 0) {
    const roleEmployer =
      roleEmployment === null
        ? null
        : (input.employments.find((e) => e.id === roleEmployment)?.company ??
          null);
    const transferableEmployers = new Set<string>();
    for (const factId of segment.citedFactIds) {
      const fact = factsById.get(factId) as Step2SnapshotFact;
      if (fact.employmentId === null) {
        for (const employment of input.employments) {
          transferableEmployers.add(employment.company);
        }
      }
    }
    const foreign = named.filter(
      (name) => name !== roleEmployer && !transferableEmployers.has(name),
    );
    if (foreign.length > 0) {
      return needs(STEP2_REASONS.NEW_EMPLOYER, [...segment.citedFactIds]);
    }
  }

  // Rule 6: default.
  return needs(STEP2_REASONS.REWORDED, [...segment.citedFactIds]);
}

export interface Step2VerdictCoverage {
  segmentId: string;
  kind: "summary" | "bullet";
  roleId: string | null;
  textHash: string;
  supported: boolean;
  factIds: string[];
  match: Step2ValidationV1["segments"][number]["match"];
  reason: string | null;
}

export interface Step2CoverageReport {
  /** Every derived segment matched a same-hash verdict. */
  covered: boolean;
  /** Every covered segment is supported. */
  allSupported: boolean;
  segments: Step2VerdictCoverage[];
  /** Derived ids with no same-hash verdict (verdict/draft skew). */
  missing: string[];
}

/**
 * Match derived segments against a persisted validation (§7.4).
 * A verdict covers a segment only when both `segmentId` and the
 * exact-bytes `textHash` agree — stale verdicts for older text
 * never apply. G gates on this; the worker rechecks it over the
 * frozen bytes before executing.
 */
export function verifyStep2VerdictCoverage(input: {
  derived: Step2DerivedSegment[];
  validation: Step2ValidationV1;
}): Step2CoverageReport {
  const byId = new Map(
    input.validation.segments.map((verdict) => [verdict.segmentId, verdict]),
  );
  const segments: Step2VerdictCoverage[] = [];
  const missing: string[] = [];
  for (const segment of input.derived) {
    const verdict = byId.get(segment.segmentId);
    const textHash = segmentTextHashFor(segment.text);
    if (verdict === undefined || verdict.textHash !== textHash) {
      missing.push(segment.segmentId);
      continue;
    }
    segments.push({
      segmentId: segment.segmentId,
      kind: segment.kind,
      roleId: segment.roleId,
      textHash,
      supported: verdict.verdict === "supported",
      factIds: [...verdict.factIds],
      match: verdict.match,
      reason: verdict.reason,
    });
  }
  return {
    covered: missing.length === 0,
    allSupported: missing.length === 0 && segments.every((segment) => segment.supported),
    segments,
    missing,
  };
}

/**
 * Validate exact edited segments under `step2-claims/1`. The caller
 * supplies the frozen binding (plan, snapshot facts, master, recorded
 * timestamps) and a trusted `validatedAt`; re-reads and hash compares
 * at the service layer keep those inputs honest.
 */
export function validateStep2Segments(
  input: ValidateStep2SegmentsInput & {
    validatedAt: string;
    summaryText: string;
    operations: Step2DraftOperationV1[];
  },
): Step2ValidationV1 {
  const factsById = new Map(
    input.snapshotFacts.map((fact) => [fact.factId, fact]),
  );
  const segments = input.segments.map((segment) =>
    verdictFor(segment, input, factsById),
  );
  const budget = checkStep2Budgets({
    summaryText: input.summaryText,
    master: input.master,
    operations: input.operations,
  });
  return {
    schemaVersion: "step2-validation/v1",
    policyVersion: STEP2_CLAIMS_POLICY,
    planId: input.planId,
    planHash: input.planHash,
    draftHash: input.draftHash,
    segments,
    budget: {
      summaryChars: budget.summaryChars,
      perRoleCounts: budget.perRoleCounts,
      totalBullets: budget.totalBullets,
      exceeded: budget.exceeded,
    },
    validatedAt: input.validatedAt,
  };
}
