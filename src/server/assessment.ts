import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client";
import {
  candidateFacts,
  candidateSnapshotFacts,
} from "../db/schema/candidates";
import { getGenerationRequest } from "../db/generation";
import {
  parseStoredPlan,
  parseStoredValidation,
  readDraftValidation,
  readPlan,
  readStep2GenerationInputs,
} from "../db/step2";
import { getAnalysisByRequest } from "../db/tailoring";
import { readRequestInputs } from "../db/tailoringWorkspace";
import { resumeClaimFacts, resumeClaims } from "../db/schema";
import { canonicalJson } from "../domain/canonical";
import {
  ASSESSMENT_CHECK_IDS,
  buildAssessmentV1,
  type AssessmentCheckInput,
} from "../domain/assessment";
import {
  FocusV1,
  RecommendationV1,
  type AssessmentV1 as AssessmentV1Type,
} from "../domain/tailoringWorkspace";

/**
 * Generation-time assessment/1 adapter (WO-1.3-G). Gathers the exact
 * frozen inputs for one publication — request inputs, edited-plan
 * inputs, validation row, plan, analysis, rendered claims, and the
 * orchestration render evidence — and builds the strict measures via
 * the pure domain core. Called inside the atomic attach transaction
 * in `src/tailoring/persist.ts`, after claims/artifacts insert and
 * before the request flips to SUCCEEDED. Lives in server (not
 * tailoring) because gathering reads frozen rows through the db
 * layer, which the tailoring purity guard forbids.
 *
 * Sourcing rules:
 * - Frozen rows only: tailoring_request_inputs, step2_generation_
 *   inputs, step2_draft_validations, step2_plans, job_analyses,
 *   resume_claims/facts, candidate_snapshot_facts, candidate_facts.
 *   Never the mutable workspace, the active profile pointer, the
 *   browser, or provider assertions (the input shape has no score
 *   field at all).
 * - No frozen request-inputs row means a legacy publish path: the
 *   caller skips assessment (review renders "not assessed"). Legacy
 *   bytes are never reinterpreted.
 * - Corrupt frozen JSON fails closed (throw): publishing without an
 *   assessment would violate atomic publication. Trigger-level JSON
 *   validity makes this a genuine-bug path only.
 * - Evidence-integrity violations (cited fact outside the bound
 *   snapshot or unapproved, non-allowlisted derivation) return
 *   `blocked` so the caller aborts the attach with zero partial
 *   writes. The claim-fact membership trigger normally enforces
 *   this at insert; this recheck is defense in depth.
 *
 * R-ADR-026 counting: only VERIFIED_SOURCE segments count as
 * machine-verified. For correction-format (claims/2) runs the
 * verified claim set joins rendered claim texts to the frozen
 * validation row's VERIFIED_SOURCE text hashes (exact multiset
 * consume). Pre-correction formats (focus/v1, claims/1) predate the
 * categories: their gate-passed claims count under their
 * contemporary semantics, and their review segments render
 * UNLABELED (never relabeled, never called verified).
 */

export const ASSESSMENT_DERIVATION_ALLOWLIST = ["derived_template"] as const;

export interface AttachRenderEvidence {
  pageCount: number;
  pageBudget: number;
  fragmentsChecked: number;
  /** Rendered view model carries summary copy or >=1 bullet. */
  contentPresent: boolean;
  /** Rendered view model carries >=1 contact part. */
  contactPresent: boolean;
  /** HTML-fragment containment held in PDF, Markdown, and DOCX. */
  parityPassed: boolean;
}

export interface AttachAssessmentInput {
  versionId: string;
  requestId: string;
  /** Canonical rendered markdown (exact bytes staged for publish). */
  tailoredMarkdown: string;
  /** Orchestration render evidence (required for assessed attaches). */
  renderEvidence: AttachRenderEvidence | null;
  now: string;
}

export type AttachAssessmentResult =
  | { status: "assessed"; measuresJson: string; assessment: AssessmentV1Type }
  | { status: "legacy-skipped" }
  | { status: "blocked"; detail: string };

function sha256HexUtf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface FrozenAssessmentContext {
  format: "focus" | "edited-plan";
  masterText: string;
  tailoredText: string;
  keywordIds: string[];
  keywordTexts: string[];
  requirementIds: string[];
  requirementEvidence: Map<string, string[]>;
  verifiedTextHashes: Map<string, number> | null;
  claims: Array<{
    id: string;
    text: string;
    factIds: string[];
    derivationKind: string | null;
  }>;
  renderEvidence: AttachRenderEvidence;
}

function readVersionClaims(
  handle: DatabaseHandle,
  versionId: string,
): FrozenAssessmentContext["claims"] {
  const rows = handle.db
    .select({
      id: resumeClaims.id,
      claimText: resumeClaims.claimText,
      derivationKind: resumeClaims.derivationKind,
    })
    .from(resumeClaims)
    .where(eq(resumeClaims.resumeVersionId, versionId))
    .orderBy(asc(resumeClaims.createdAt), asc(resumeClaims.id))
    .all();
  return rows.map((row) => {
    const links = handle.db
      .select({ factId: resumeClaimFacts.factId })
      .from(resumeClaimFacts)
      .where(eq(resumeClaimFacts.claimId, row.id))
      .all();
    return {
      id: row.id,
      text: row.claimText,
      factIds: links.map((link) => link.factId),
      derivationKind: row.derivationKind,
    };
  });
}

function readAnalysisRequirements(handle: DatabaseHandle, requestId: string): {
  requirementIds: string[];
  requirementEvidence: Map<string, string[]>;
} {
  const analysis = getAnalysisByRequest(handle, requestId);
  if (analysis === null) {
    throw new Error(
      `internal: assessment found no analysis for request '${requestId}'`,
    );
  }
  let doc: unknown;
  try {
    doc = JSON.parse(analysis.requirementsJson) as unknown;
  } catch {
    throw new Error("internal: frozen analysis requirements are not JSON");
  }
  const record = asRecord(doc);
  const entries = Array.isArray(record?.["requirements"])
    ? (record?.["requirements"] as unknown[])
    : null;
  if (entries === null) {
    throw new Error("internal: frozen analysis requirements lack entries");
  }
  const requirementIds: string[] = [];
  const requirementEvidence = new Map<string, string[]>();
  for (const entry of entries) {
    const item = asRecord(entry);
    const id = item === null ? null : item["requirement_id"];
    if (typeof id !== "string" || id === "") {
      throw new Error("internal: frozen requirement lacks an id");
    }
    const evidence = item?.["evidence_fact_ids"];
    const factIds = Array.isArray(evidence)
      ? evidence.filter((fact): fact is string => typeof fact === "string")
      : [];
    requirementIds.push(id);
    requirementEvidence.set(id, factIds);
  }
  return { requirementIds, requirementEvidence };
}

function gatherFrozenContext(
  handle: DatabaseHandle,
  input: AttachAssessmentInput,
): FrozenAssessmentContext | null {
  const inputs = readRequestInputs(handle, input.requestId);
  if (inputs === null) {
    return null;
  }
  const request = getGenerationRequest(handle, input.requestId);
  if (request === null) {
    throw new Error(
      `internal: assessment found request inputs without a request row '${input.requestId}'`,
    );
  }
  const { requirementIds, requirementEvidence } = readAnalysisRequirements(
    handle,
    input.requestId,
  );
  const claims = readVersionClaims(handle, input.versionId);
  if (input.renderEvidence === null) {
    throw new Error(
      "internal: assessed attach requires orchestration render evidence",
    );
  }

  const step2 = readStep2GenerationInputs(handle, input.requestId);
  if (step2 === null) {
    let focus: unknown;
    let recommendations: unknown;
    try {
      focus = JSON.parse(inputs.focusJson) as unknown;
      recommendations = JSON.parse(inputs.recommendationsJson) as unknown;
    } catch {
      throw new Error("internal: frozen focus inputs are not JSON");
    }
    const parsedFocus = FocusV1.parse(focus);
    const parsedRecommendations = RecommendationV1.parse(recommendations);
    const supported = new Map(
      parsedRecommendations.phrases
        .filter((phrase) => phrase.support === "supported")
        .map((phrase) => [phrase.id, phrase.text]),
    );
    const keywordIds: string[] = [];
    const keywordTexts: string[] = [];
    for (const id of parsedFocus.selectedPhraseIds) {
      const text = supported.get(id);
      if (text !== undefined) {
        keywordIds.push(id);
        keywordTexts.push(text);
      }
    }
    return {
      format: "focus",
      masterText: inputs.masterText,
      tailoredText: input.tailoredMarkdown,
      keywordIds,
      keywordTexts,
      requirementIds,
      requirementEvidence,
      verifiedTextHashes: null,
      claims,
      renderEvidence: input.renderEvidence,
    };
  }

  let editedInputs: unknown;
  try {
    editedInputs = JSON.parse(step2.editedInputsJson) as unknown;
  } catch {
    throw new Error("internal: frozen edited inputs are not JSON");
  }
  const editedRecord = asRecord(editedInputs);
  const editedVersion =
    editedRecord === null ? null : editedRecord["schemaVersion"];
  const isCorrection = editedVersion === "step2-edited-inputs/v2";
  if (
    editedVersion !== "step2-edited-inputs/v1" &&
    editedVersion !== "step2-edited-inputs/v2"
  ) {
    throw new Error(
      `internal: frozen edited inputs carry unknown schema '${String(editedVersion)}'`,
    );
  }
  const planRow = readPlan(handle, step2.planId);
  if (planRow === null) {
    throw new Error(
      `internal: assessment found no frozen plan '${step2.planId}'`,
    );
  }
  const storedPlan = parseStoredPlan(planRow.planJson);
  if (storedPlan === null) {
    throw new Error("internal: frozen plan failed strict parsing");
  }
  const priorities =
    storedPlan.version === 1 ? storedPlan.plan.priorities : storedPlan.plan.priorities;
  const keywordIds: string[] = [];
  const keywordTexts: string[] = [];
  for (const priority of priorities) {
    if (priority.support === "gap") {
      continue;
    }
    keywordIds.push(priority.priorityId);
    keywordTexts.push(priority.quote.text);
  }
  let verifiedTextHashes: Map<string, number> | null = null;
  if (isCorrection) {
    const validationRow = readDraftValidation(handle, step2.validationId);
    if (validationRow === null) {
      throw new Error(
        `internal: assessment found no frozen validation '${step2.validationId}'`,
      );
    }
    const stored = parseStoredValidation(validationRow.verdictJson);
    if (stored === null || stored.version !== 2) {
      throw new Error(
        "internal: frozen correction validation failed strict parsing",
      );
    }
    verifiedTextHashes = new Map<string, number>();
    for (const segment of stored.validation.segments) {
      if (segment.provenance !== "VERIFIED_SOURCE") {
        continue;
      }
      verifiedTextHashes.set(
        segment.textHash,
        (verifiedTextHashes.get(segment.textHash) ?? 0) + 1,
      );
    }
  }
  return {
    format: "edited-plan",
    masterText: inputs.masterText,
    tailoredText: input.tailoredMarkdown,
    keywordIds,
    keywordTexts,
    requirementIds,
    requirementEvidence,
    verifiedTextHashes,
    claims,
    renderEvidence: input.renderEvidence,
  };
}

function verifyEvidenceIntact(
  handle: DatabaseHandle,
  requestId: string,
  claims: FrozenAssessmentContext["claims"],
): { intact: boolean[] } | { blocked: string } {
  const analysis = getAnalysisByRequest(handle, requestId);
  if (analysis === null) {
    throw new Error(
      `internal: assessment found no analysis for request '${requestId}'`,
    );
  }
  const intact: boolean[] = [];
  for (const claim of claims) {
    if (
      claim.derivationKind !== null &&
      !(ASSESSMENT_DERIVATION_ALLOWLIST as readonly string[]).includes(
        claim.derivationKind,
      )
    ) {
      return {
        blocked: `claim '${claim.id}' carries non-allowlisted derivation '${claim.derivationKind}'`,
      };
    }
    for (const factId of claim.factIds) {
      const member = handle.db
        .select({ factId: candidateSnapshotFacts.factId })
        .from(candidateSnapshotFacts)
        .where(
          and(
            eq(candidateSnapshotFacts.snapshotId, analysis.candidateSnapshotId),
            eq(candidateSnapshotFacts.factId, factId),
          ),
        )
        .get();
      const approved = handle.db
        .select({ factId: candidateFacts.factId })
        .from(candidateFacts)
        .where(
          and(
            eq(candidateFacts.factId, factId),
            eq(candidateFacts.verification, "APPROVED"),
          ),
        )
        .get();
      if (member === undefined || approved === undefined) {
        return {
          blocked: `claim '${claim.id}' cites fact '${factId}' outside the bound approved snapshot`,
        };
      }
    }
    intact.push(true);
  }
  return { intact };
}

/**
 * Compute the assessment/1 measures for one attaching version.
 * Runs inside the publication transaction; SELECTs only. Returns
 * `legacy-skipped` when the request has no frozen v1.3 inputs,
 * `blocked` on an evidence-integrity violation (the caller aborts
 * the attach with zero writes), and throws loudly on corrupt
 * frozen state (fail-closed: never publish without assessment).
 */
export function computeAssessmentForAttach(
  handle: DatabaseHandle,
  input: AttachAssessmentInput,
): AttachAssessmentResult {
  const frozen = gatherFrozenContext(handle, input);
  if (frozen === null) {
    return { status: "legacy-skipped" };
  }

  // Verified claim multiset (correction format): rendered claim
  // texts joining the frozen VERIFIED_SOURCE text hashes, consumed
  // in claim order. Pre-correction formats count gate-passed
  // claims under their contemporary semantics (no join).
  const verifiedClaimIds = new Set<string>();
  if (frozen.verifiedTextHashes !== null) {
    const remaining = new Map(frozen.verifiedTextHashes);
    for (const claim of frozen.claims) {
      const hash = sha256HexUtf8(claim.text);
      const left = remaining.get(hash) ?? 0;
      if (left > 0) {
        remaining.set(hash, left - 1);
        verifiedClaimIds.add(claim.id);
      }
    }
  } else {
    for (const claim of frozen.claims) {
      verifiedClaimIds.add(claim.id);
    }
  }

  const coveredIds: string[] = [];
  for (const requirementId of frozen.requirementIds) {
    const evidence = frozen.requirementEvidence.get(requirementId) ?? [];
    if (evidence.length === 0) {
      continue;
    }
    const evidenceSet = new Set(evidence);
    const linked = frozen.claims.some(
      (claim) =>
        verifiedClaimIds.has(claim.id) &&
        claim.factIds.some((factId) => evidenceSet.has(factId)),
    );
    if (linked) {
      coveredIds.push(requirementId);
    }
  }

  const evidence = verifyEvidenceIntact(handle, input.requestId, frozen.claims);
  if ("blocked" in evidence) {
    return { status: "blocked", detail: evidence.blocked };
  }
  const evidenceClaims = frozen.claims
    .filter(
      (claim) => claim.factIds.length > 0 || claim.derivationKind !== null,
    )
    .map((claim) => ({ claimId: claim.id, intact: true }));

  const checks: AssessmentCheckInput[] = [
    {
      id: "nonempty-content",
      passed: frozen.claims.some((claim) => claim.text.trim() !== ""),
    },
    { id: "valid-contact", passed: frozen.renderEvidence.contactPresent },
    {
      id: "no-render-overflow",
      passed:
        frozen.renderEvidence.pageCount >= 1 &&
        frozen.renderEvidence.pageCount <= frozen.renderEvidence.pageBudget,
    },
    {
      id: "cross-format-parity",
      passed:
        frozen.renderEvidence.parityPassed &&
        frozen.renderEvidence.fragmentsChecked > 0,
    },
  ];
  for (const id of ASSESSMENT_CHECK_IDS) {
    if (!checks.some((check) => check.id === id)) {
      throw new Error(`internal: assessment omitted check '${id}'`);
    }
  }

  const assessment = buildAssessmentV1({
    keywords: {
      itemIds: frozen.keywordIds,
      texts: frozen.keywordTexts,
      masterText: frozen.masterText,
      tailoredText: frozen.tailoredText,
    },
    requirements: { itemIds: frozen.requirementIds, coveredIds },
    checks,
    evidence: evidenceClaims,
  });
  return {
    status: "assessed",
    measuresJson: canonicalJson(assessment),
    assessment,
  };
}
