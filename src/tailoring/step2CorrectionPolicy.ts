import { canonicalJson, canonicalText } from "../domain/canonical";
import {
  PREPARE_PROMPT_VERSION_V2,
  STEP2_CLAIMS_POLICY_V2,
  STEP2_CORRECTION_VERSIONS,
  deriveEligibleRoles,
  deriveSegmentProvenance,
  type CorrectionDerivedSegment,
  type PreparationPlanV2,
  type Step2DraftOperationV2,
  type Step2DraftV2,
  type Step2PolicyVersionsV2,
  type Step2Provenance,
  type Step2SegmentOriginV2,
  type Step2StructuralReason,
  type Step2ValidationV2,
} from "../domain/step2Correction";
import {
  claimKey,
  namedCompanies,
  type Step2SnapshotFact,
} from "../domain/step2Claims";
import {
  checkStep2Budgets,
  type MasterBullet,
} from "../domain/step2";
import { sha256HexUtf8 } from "./hash";

/**
 * WO-1.3-S2-CP-A executable correction policy: §2 digests,
 * `step2-claims/2` verdict computation, and frozen-coverage checks.
 *
 * Hashes live in tailoring (like `phraseIdFor` and the v1
 * `step2policy` digests) because the domain purity guard restricts
 * `src/domain` to Zod plus sibling modules. Pure: no database,
 * clock, provider, or filesystem access.
 *
 * `step2-claims/2` separates provenance (never blocking) from
 * structural validity (blocking). Provenance is derived from the
 * immutable origin, the saved operation, and exact text; providers
 * and public payloads cannot assign it. User edits — including
 * unverified metrics, technologies, and responsibilities — are
 * structurally valid and generatable verbatim as `USER_EDITED`.
 */

/* ------------------------------------------------------------------ */
/* §2 digests                                                          */
/* ------------------------------------------------------------------ */

export function correctionPlanHashFor(plan: PreparationPlanV2): string {
  return sha256HexUtf8(canonicalJson(plan));
}

export function correctionDraftHashFor(draft: Step2DraftV2): string {
  return sha256HexUtf8(
    canonicalJson({
      planId: draft.planId,
      planHash: draft.planHash,
      summaryText: draft.summaryText,
      summaryOrigin: draft.summaryOrigin,
      operations: draft.operations,
    }),
  );
}

export function correctionSegmentTextHashFor(text: string): string {
  return sha256HexUtf8(text);
}

export function correctionSegmentNormalizedHashFor(text: string): string {
  return sha256HexUtf8(canonicalText(text));
}

export interface CorrectionManifestEntry {
  segmentId: string;
  kind: "summary" | "bullet";
  roleId: string | null;
  origin: Step2SegmentOriginV2;
  anchorFactIds: string[];
  priorityIds: string[];
  textHash: string;
  normalizedHash: string;
  provenance: Step2Provenance;
  sourceOperationId: string | null;
}

/**
 * Content hash over the frozen provenance manifest (entries in
 * segment order). Bound into `step2-request-input/v2` so the worker
 * executes exactly the provenance the freeze derived.
 */
export function correctionManifestHashFor(
  manifest: CorrectionManifestEntry[],
): string {
  return sha256HexUtf8(canonicalJson(manifest));
}

/** Frozen policy lineage pinned into every correction generation. */
export function step2CorrectionPolicies(): Step2PolicyVersionsV2 {
  return {
    schemaVersion: STEP2_CORRECTION_VERSIONS.policyVersions,
    claims: STEP2_CLAIMS_POLICY_V2,
    master: "step2-master-bullets/1",
    prompt: PREPARE_PROMPT_VERSION_V2,
  };
}

export const STEP2_CORRECTION_WORKFLOW_INPUT_SCHEMA_VERSION =
  "step2-request-input/v2";

export interface Step2CorrectionWorkflowInput {
  workspaceRevision: number;
  planId: string;
  planHash: string;
  draftHash: string;
  validationId: string;
  provenanceManifestHash: string;
  candidateSnapshotId: string;
  masterText: string;
  masterTextHash: string;
  projectionVersion: "master-text/1";
  policies: Step2PolicyVersionsV2;
}

/**
 * `step2-request-input/v2`: the v3 queue payload's `inputHash` for
 * correction requests. Extends the v1 workflow input with the
 * provenance manifest hash — a new digest name, never a
 * reinterpretation of v1 bytes. G and the worker recompute
 * identically.
 */
export function hashStep2CorrectionWorkflowInput(
  input: Step2CorrectionWorkflowInput,
): string {
  return sha256HexUtf8(
    canonicalJson({
      schemaVersion: STEP2_CORRECTION_WORKFLOW_INPUT_SCHEMA_VERSION,
      workspaceRevision: input.workspaceRevision,
      planId: input.planId,
      planHash: input.planHash,
      draftHash: input.draftHash,
      validationId: input.validationId,
      provenanceManifestHash: input.provenanceManifestHash,
      candidateSnapshotId: input.candidateSnapshotId,
      masterText: input.masterText,
      masterTextHash: input.masterTextHash,
      projectionVersion: input.projectionVersion,
      policies: input.policies,
    }),
  );
}

/** Recompute a v2 draft hash for race comparison (G-v2 gate). */
export function correctionDraftHashMatches(
  expected: string,
  draft: {
    planId: string;
    planHash: string;
    summaryText: string;
    summaryOrigin: "master" | "angle-1" | "angle-2";
    operations: Step2DraftOperationV2[];
  },
): boolean {
  return (
    correctionDraftHashFor({
      schemaVersion: "step2-draft/v2",
      planId: draft.planId,
      planHash: draft.planHash,
      summaryText: draft.summaryText,
      summaryOrigin: draft.summaryOrigin,
      operations: draft.operations,
    }) === expected
  );
}

/* ------------------------------------------------------------------ */
/* step2-claims/2 verdicts                                             */
/* ------------------------------------------------------------------ */

export interface ValidateCorrectionSegmentsInput {
  segments: CorrectionDerivedSegment[];
  plan: PreparationPlanV2;
  planHash: string;
  draftHash: string;
  boundProfileVersionId: string;
  snapshotFacts: Step2SnapshotFact[];
  master: MasterBullet[];
  masterSummary: string;
  employments: Array<{ id: string; company: string }>;
  versionCreatedAt: string;
  planAcceptedAt: string;
  now: string;
  validatedAt: string;
  summaryText: string;
  operations: Step2DraftOperationV2[];
  derivation?: { finalText: string; factIds: string[] };
}

interface CorrectionVerdict {
  segmentId: string;
  kind: "summary" | "bullet";
  roleId: string | null;
  origin: Step2SegmentOriginV2;
  anchorFactIds: string[];
  priorityIds: string[];
  textHash: string;
  normalizedHash: string;
  provenance: Step2Provenance;
  structural: { ok: boolean; reason: Step2StructuralReason | null };
  match: "exact-fact" | "exact-plan" | "exact-master" | "derivation" | "none";
  reason: Step2StructuralReason | null;
}

function originTextOf(
  segment: CorrectionDerivedSegment,
  input: ValidateCorrectionSegmentsInput,
  bulletByFact: ReadonlyMap<string, MasterBullet>,
): { text: string; usable: boolean; known: boolean } {
  const origin = segment.origin;
  if (origin.kind === "master-summary") {
    return { text: input.masterSummary, usable: true, known: true };
  }
  if (origin.kind === "master-bullet") {
    const bullet = bulletByFact.get(origin.factId);
    if (bullet === undefined) {
      return { text: "", usable: true, known: false };
    }
    return { text: bullet.text, usable: true, known: true };
  }
  if (origin.kind === "angle") {
    const angle = input.plan.positioning.angles.find(
      (entry) => entry.angleId === origin.angleId,
    );
    if (angle === undefined) {
      return { text: "", usable: false, known: false };
    }
    return { text: angle.summaryText, usable: true, known: true };
  }
  const suggestion = input.plan.suggestions.find(
    (entry) => entry.suggestionId === origin.suggestionId,
  );
  if (suggestion === undefined) {
    return { text: "", usable: false, known: false };
  }
  return { text: suggestion.text, usable: suggestion.usable, known: true };
}

function matchOf(
  segment: CorrectionDerivedSegment,
  input: ValidateCorrectionSegmentsInput,
  factsById: ReadonlyMap<string, Step2SnapshotFact>,
  planTexts: string[],
): CorrectionVerdict["match"] {
  const key = claimKey(segment.text);
  for (const factId of segment.anchorFactIds) {
    const fact = factsById.get(factId);
    if (fact !== undefined && claimKey(fact.statement) === key) {
      return "exact-fact";
    }
  }
  for (const text of planTexts) {
    if (claimKey(text) === key) {
      return "exact-plan";
    }
  }
  if (segment.kind === "bullet") {
    for (const bullet of input.master) {
      if (
        (segment.roleId === null || bullet.roleId === segment.roleId) &&
        claimKey(bullet.text) === key
      ) {
        return "exact-master";
      }
    }
  }
  const manifest = input.derivation;
  if (
    manifest !== undefined &&
    manifest.finalText === segment.text &&
    manifest.factIds.length === segment.anchorFactIds.length &&
    manifest.factIds.every((id) => segment.anchorFactIds.includes(id))
  ) {
    return "derivation";
  }
  return "none";
}

function verdictFor(
  segment: CorrectionDerivedSegment,
  input: ValidateCorrectionSegmentsInput,
  factsById: ReadonlyMap<string, Step2SnapshotFact>,
  bulletByFact: ReadonlyMap<string, MasterBullet>,
  planPriorityIds: ReadonlySet<string>,
  planTexts: string[],
): CorrectionVerdict {
  const base = {
    segmentId: segment.segmentId,
    kind: segment.kind,
    roleId: segment.roleId,
    origin: segment.origin,
    anchorFactIds: [...segment.anchorFactIds],
    priorityIds: [...segment.priorityIds],
    textHash: correctionSegmentTextHashFor(segment.text),
    normalizedHash: correctionSegmentNormalizedHashFor(segment.text),
  };
  const blocked = (
    reason: Step2StructuralReason,
    provenance: Step2Provenance,
  ): CorrectionVerdict => ({
    ...base,
    provenance,
    structural: { ok: false as const, reason },
    match: matchOf(segment, input, factsById, planTexts),
    reason,
  });

  const origin = originTextOf(segment, input, bulletByFact);
  if (!origin.known) {
    return blocked("UNKNOWN_ORIGIN", "USER_EDITED");
  }

  // Chronology over recorded version/plan lineage (same rule as /1).
  if (
    input.versionCreatedAt > input.planAcceptedAt ||
    input.planAcceptedAt > input.now
  ) {
    return blocked("CHRONOLOGY", "USER_EDITED");
  }

  // Anchors must exist, be approved, and belong to the bound version.
  // Reference existence alone never passes: provenance additionally
  // requires text equality with the origin (derived below).
  for (const factId of segment.anchorFactIds) {
    const fact = factsById.get(factId);
    if (fact === undefined) {
      return blocked("INVALID_ANCHOR", "USER_EDITED");
    }
    if (fact.verification !== "APPROVED") {
      return blocked("INVALID_ANCHOR", "USER_EDITED");
    }
    if (fact.profileVersionId !== input.boundProfileVersionId) {
      return blocked("INVALID_ANCHOR", "USER_EDITED");
    }
  }
  const lineageIntact = true;

  // AI origins must link ≥1 same-plan priority. Master origins carry
  // no priority links (empty by construction).
  if (
    segment.origin.kind === "angle" ||
    segment.origin.kind === "suggestion"
  ) {
    if (segment.priorityIds.length === 0) {
      return blocked("PRIORITY_LINK_MISSING", "USER_EDITED");
    }
    for (const priorityId of segment.priorityIds) {
      if (!planPriorityIds.has(priorityId)) {
        return blocked("FOREIGN_PRIORITY", "USER_EDITED");
      }
    }
    if (new Set(segment.priorityIds).size !== segment.priorityIds.length) {
      return blocked("PRIORITY_LINK_MISSING", "USER_EDITED");
    }
  }

  // Role ownership and server-derived eligibility. Master-bullet
  // edits stay in their own role; suggestion instances must land in
  // a derived eligible role.
  if (segment.kind === "bullet") {
    const employmentIds = input.employments.map((entry) => entry.id);
    if (segment.roleId === null || !employmentIds.includes(segment.roleId)) {
      return blocked("UNKNOWN_ROLE", "USER_EDITED");
    }
    if (segment.origin.kind === "master-bullet") {
      const bullet = bulletByFact.get(segment.origin.factId);
      if (bullet !== undefined && bullet.roleId !== segment.roleId) {
        return blocked("FOREIGN_ROLE", "USER_EDITED");
      }
    } else if (segment.origin.kind === "suggestion") {
      const employmentByFactId = new Map<string, string | null>();
      for (const factId of segment.anchorFactIds) {
        const fact = factsById.get(factId) as Step2SnapshotFact;
        employmentByFactId.set(factId, fact.employmentId);
      }
      const derived = deriveEligibleRoles({
        citedFactIds: segment.anchorFactIds,
        employmentByFactId,
        employmentIds,
      });
      if (
        derived.ownership === "mixed" ||
        derived.ownership === "unknown" ||
        !derived.eligibleRoleIds.includes(segment.roleId)
      ) {
        return blocked("FOREIGN_ROLE", "USER_EDITED");
      }
      if (!origin.usable) {
        return blocked("UNUSABLE_SUGGESTION", "USER_EDITED");
      }
      // Untouched AI text keeps the deterministic employer guard
      // (traceability, not proof). User-edited text is exempt: the
      // user is authoritative for their own wording.
      if (!segment.userEdited) {
        const named = namedCompanies(segment.text, input.employments);
        const eligibleEmployers = new Set(
          input.employments
            .filter((entry) => derived.eligibleRoleIds.includes(entry.id))
            .map((entry) => entry.company),
        );
        if (named.some((name) => !eligibleEmployers.has(name))) {
          return blocked("FOREIGN_EMPLOYER", "USER_EDITED");
        }
      }
    }
  }
  // Angle summary origins carry no usability flag: selecting an
  // angle is always allowed, and its text becomes USER_ACCEPTED_AI
  // (or USER_EDITED when reworded) below.

  const provenance = deriveSegmentProvenance({
    origin: segment.origin,
    originText: origin.text,
    text: segment.text,
    userEdited: segment.userEdited,
    originUsable: origin.usable,
    lineageIntact,
  });
  return {
    ...base,
    provenance,
    structural: { ok: true as const, reason: null },
    match: matchOf(segment, input, factsById, planTexts),
    reason: null,
  };
}

/**
 * Validate exact v2 segments under `step2-claims/2`. The caller
 * supplies the frozen binding (plan, snapshot facts, master,
 * recorded timestamps) and a trusted `validatedAt`; re-reads and
 * hash compares at the service layer keep those inputs honest.
 * User edits are never blocked for lack of machine evidence —
 * only structural, ownership, size, and binding failures block.
 */
export function validateCorrectionSegments(
  input: ValidateCorrectionSegmentsInput,
): Step2ValidationV2 {
  const factsById = new Map(
    input.snapshotFacts.map((fact) => [fact.factId, fact]),
  );
  const bulletByFact = new Map(
    input.master.map((bullet) => [bullet.factId, bullet]),
  );
  const planPriorityIds = new Set(
    input.plan.priorities.map((priority) => priority.priorityId),
  );
  const planTexts: string[] = [
    ...input.plan.suggestions.map((suggestion) => suggestion.text),
    ...input.plan.positioning.angles.map((angle) => angle.summaryText),
  ];
  const segments = input.segments.map((segment) =>
    verdictFor(segment, input, factsById, bulletByFact, planPriorityIds, planTexts),
  );
  const budget = checkStep2Budgets({
    summaryText: input.summaryText,
    master: input.master,
    operations: input.operations,
  });
  const provenanceCounts = {
    verifiedSource: segments.filter(
      (segment) => segment.provenance === "VERIFIED_SOURCE",
    ).length,
    userAcceptedAi: segments.filter(
      (segment) => segment.provenance === "USER_ACCEPTED_AI",
    ).length,
    userEdited: segments.filter(
      (segment) => segment.provenance === "USER_EDITED",
    ).length,
  };
  return {
    schemaVersion: "step2-validation/v2",
    policyVersion: STEP2_CLAIMS_POLICY_V2,
    planId: input.plan.planId,
    planHash: input.planHash,
    draftHash: input.draftHash,
    segments,
    provenanceCounts,
    budget,
    validatedAt: input.validatedAt,
  };
}

export interface CorrectionCoverageSegment {
  segmentId: string;
  kind: "summary" | "bullet";
  roleId: string | null;
  textHash: string;
  provenance: Step2Provenance;
  structuralOk: boolean;
  structuralReason: Step2StructuralReason | null;
}

export interface CorrectionCoverageReport {
  /** Every derived segment matched a same-hash verdict. */
  covered: boolean;
  /** Every covered segment is structurally sound. Provenance never blocks. */
  allStructuralOk: boolean;
  segments: CorrectionCoverageSegment[];
  /** Derived ids with no same-hash verdict (verdict/draft skew). */
  missing: string[];
}

/**
 * Match derived v2 segments against a persisted v2 validation. A
 * verdict covers a segment only when both `segmentId` and the
 * exact-bytes `textHash` agree — stale verdicts for older text
 * never apply. G-v2 gates on `covered && allStructuralOk`; the
 * worker rechecks it over the frozen bytes before executing.
 */
export function verifyCorrectionCoverage(input: {
  derived: CorrectionDerivedSegment[];
  validation: Step2ValidationV2;
}): CorrectionCoverageReport {
  const byId = new Map(
    input.validation.segments.map((verdict) => [verdict.segmentId, verdict]),
  );
  const segments: CorrectionCoverageSegment[] = [];
  const missing: string[] = [];
  for (const segment of input.derived) {
    const verdict = byId.get(segment.segmentId);
    const textHash = correctionSegmentTextHashFor(segment.text);
    if (verdict === undefined || verdict.textHash !== textHash) {
      missing.push(segment.segmentId);
      continue;
    }
    segments.push({
      segmentId: segment.segmentId,
      kind: segment.kind,
      roleId: segment.roleId,
      textHash,
      provenance: verdict.provenance,
      structuralOk: verdict.structural.ok,
      structuralReason: verdict.structural.reason,
    });
  }
  return {
    covered: missing.length === 0,
    allStructuralOk:
      missing.length === 0 &&
      segments.every((segment) => segment.structuralOk),
    segments,
    missing,
  };
}

/**
 * Evidence-integrity numerator/denominator inputs for G assessment:
 * only `VERIFIED_SOURCE` segments count as machine-verified. The
 * non-verified categories are reported separately and never
 * inflate either side.
 */
export function correctionVerifiedCoverage(input: {
  validation: Step2ValidationV2;
}): {
  verifiedSegmentIds: string[];
  nonVerifiedSegmentIds: string[];
} {
  const verifiedSegmentIds: string[] = [];
  const nonVerifiedSegmentIds: string[] = [];
  for (const segment of input.validation.segments) {
    if (segment.provenance === "VERIFIED_SOURCE") {
      verifiedSegmentIds.push(segment.segmentId);
    } else {
      nonVerifiedSegmentIds.push(segment.segmentId);
    }
  }
  return { verifiedSegmentIds, nonVerifiedSegmentIds };
}
