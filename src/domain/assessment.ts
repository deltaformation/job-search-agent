import {
  AssessmentV1,
  type AssessmentMeasureV1,
  type MeasureSide,
} from "./tailoringWorkspace";

/**
 * Pure assessment/1 measure builders (WO-1.3-G). Total functions over
 * plain frozen inputs: phrase matching, per-measure sides, and the
 * strict AssessmentV1 assembly. No database, filesystem, clock, or
 * provider input — the tailoring adapter (`src/tailoring/assessment`)
 * gathers the frozen rows and calls these builders inside the atomic
 * publication transaction.
 *
 * Rules (R-ADR-024, R-ADR-026):
 * - Zero eligible items is `not_assessed` (never 0% or 100%).
 * - Only `VERIFIED_SOURCE` segments count as machine-verified. The
 *   caller partitions verified claims before calling; this module
 *   never sees provenance and cannot smuggle it.
 * - No composite score exists anywhere in this module: four
 *   independent measures, no combination.
 * - Provider- or browser-supplied scores cannot enter: the input
 *   shape has no score field, and AssessmentV1 is strict.
 */

export const ASSESSMENT_CHECK_IDS = [
  "nonempty-content",
  "valid-contact",
  "no-render-overflow",
  "cross-format-parity",
] as const;
export type AssessmentCheckId = (typeof ASSESSMENT_CHECK_IDS)[number];

/** Casefold + collapse interior whitespace for phrase matching. */
export function normalizeAssessmentPhrase(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isWordChar(char: string): boolean {
  return (
    (char >= "a" && char <= "z") ||
    (char >= "0" && char <= "9") ||
    char === "_"
  );
}

/**
 * Whole-phrase presence under casefolded whitespace-collapsed
 * comparison with token boundaries (so "Go" never matches
 * "go-to-market" or "Django"). Empty phrases never match.
 */
export function assessmentPhrasePresent(
  haystack: string,
  phrase: string,
): boolean {
  const needle = normalizeAssessmentPhrase(phrase);
  if (needle === "") {
    return false;
  }
  const hay = normalizeAssessmentPhrase(haystack);
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) {
      return false;
    }
    const before = at === 0 ? "" : (hay[at - 1] as string);
    const after =
      at + needle.length >= hay.length
        ? ""
        : (hay[at + needle.length] as string);
    if (
      (before === "" || !isWordChar(before)) &&
      (after === "" || !isWordChar(after))
    ) {
      return true;
    }
    from = at + 1;
  }
}

export function countAssessmentMatches(
  haystack: string,
  phrases: string[],
): number {
  let count = 0;
  for (const phrase of phrases) {
    if (assessmentPhrasePresent(haystack, phrase)) {
      count += 1;
    }
  }
  return count;
}

export function notAssessed(
  reason: Extract<
    MeasureSide,
    { status: "not_assessed" }
  >["reason"],
): MeasureSide {
  return { status: "not_assessed", reason };
}

function assessedSide(numerator: number, denominator: number): MeasureSide {
  if (denominator <= 0 || numerator < 0 || numerator > denominator) {
    throw new Error(
      `internal: invalid assessed side ${numerator}/${denominator}`,
    );
  }
  return { status: "assessed", numerator, denominator };
}

export interface AssessmentKeywordInput {
  /** Eligible frozen phrase ids (order-stable). */
  itemIds: string[];
  /** Parallel phrase texts for matching. */
  texts: string[];
  /** Frozen master text, or null when the baseline is unavailable. */
  masterText: string | null;
  /** Canonical tailored text. */
  tailoredText: string;
}

export function buildKeywordMeasure(
  input: AssessmentKeywordInput,
): AssessmentMeasureV1 {
  if (input.itemIds.length !== input.texts.length) {
    throw new Error("internal: keyword ids and texts diverge");
  }
  if (input.itemIds.length === 0) {
    return {
      key: "selected_keywords",
      original: notAssessed("NO_ELIGIBLE_ITEMS"),
      tailored: notAssessed("NO_ELIGIBLE_ITEMS"),
      itemIds: [],
    };
  }
  const tailored = assessedSide(
    countAssessmentMatches(input.tailoredText, input.texts),
    input.itemIds.length,
  );
  const original =
    input.masterText === null
      ? notAssessed("BASELINE_UNAVAILABLE")
      : assessedSide(
          countAssessmentMatches(input.masterText, input.texts),
          input.itemIds.length,
        );
  return {
    key: "selected_keywords",
    original,
    tailored,
    itemIds: [...input.itemIds],
  };
}

export interface AssessmentRequirementInput {
  /** Eligible supported requirement ids (gaps excluded upstream). */
  itemIds: string[];
  /** Ids linked to >=1 rendered verified claim (subset of itemIds). */
  coveredIds: string[];
}

export function buildRequirementMeasure(
  input: AssessmentRequirementInput,
): AssessmentMeasureV1 {
  if (input.itemIds.length === 0) {
    return {
      key: "supported_requirements",
      original: notAssessed("NO_ELIGIBLE_ITEMS"),
      tailored: notAssessed("NO_ELIGIBLE_ITEMS"),
      itemIds: [],
    };
  }
  const eligible = new Set(input.itemIds);
  const seen = new Set<string>();
  let covered = 0;
  for (const id of input.coveredIds) {
    if (eligible.has(id) && !seen.has(id)) {
      seen.add(id);
      covered += 1;
    }
  }
  return {
    key: "supported_requirements",
    // No original claim mapping exists for the frozen master: the
    // master was never rendered through the claim pipeline.
    original: notAssessed("BASELINE_UNAVAILABLE"),
    tailored: assessedSide(covered, input.itemIds.length),
    itemIds: [...input.itemIds],
  };
}

export interface AssessmentCheckInput {
  id: AssessmentCheckId;
  /** True when the check ran and passed; unrun checks never pass. */
  passed: boolean;
}

export function buildDocumentChecksMeasure(
  checks: AssessmentCheckInput[],
): AssessmentMeasureV1 {
  const seen = new Set<string>();
  let passed = 0;
  for (const check of checks) {
    if (seen.has(check.id)) {
      throw new Error(`internal: duplicate document check ${check.id}`);
    }
    seen.add(check.id);
    if (check.passed) {
      passed += 1;
    }
  }
  if (checks.length === 0) {
    return {
      key: "document_checks",
      original: notAssessed("CHECK_NOT_APPLICABLE"),
      tailored: notAssessed("CHECK_NOT_APPLICABLE"),
      itemIds: [],
    };
  }
  return {
    key: "document_checks",
    // No equivalent master render set exists.
    original: notAssessed("BASELINE_UNAVAILABLE"),
    tailored: assessedSide(passed, checks.length),
    itemIds: checks.map((check) => check.id),
  };
}

export interface AssessmentEvidenceClaim {
  claimId: string;
  /** True when every cited fact verifies and derivation is allowlisted. */
  intact: boolean;
}

export function buildEvidenceMeasure(
  claims: AssessmentEvidenceClaim[],
): AssessmentMeasureV1 {
  if (claims.length === 0) {
    return {
      key: "evidence_integrity",
      original: notAssessed("NO_ELIGIBLE_ITEMS"),
      tailored: notAssessed("NO_ELIGIBLE_ITEMS"),
      itemIds: [],
    };
  }
  let intact = 0;
  for (const claim of claims) {
    if (claim.intact) {
      intact += 1;
    }
  }
  return {
    key: "evidence_integrity",
    // No generated claim inventory exists for the frozen master.
    original: notAssessed("BASELINE_UNAVAILABLE"),
    tailored: assessedSide(intact, claims.length),
    itemIds: claims.map((claim) => claim.claimId),
  };
}

export interface AssessmentAssembly {
  keywords: AssessmentKeywordInput;
  requirements: AssessmentRequirementInput;
  checks: AssessmentCheckInput[];
  evidence: AssessmentEvidenceClaim[];
}

/** Assemble and strictly validate the four independent measures. */
export function buildAssessmentV1(input: AssessmentAssembly): {
  schemaVersion: "resume-assessment/v1";
  policyVersion: "assessment/1";
  measures: AssessmentMeasureV1[];
} {
  return AssessmentV1.parse({
    schemaVersion: "resume-assessment/v1",
    policyVersion: "assessment/1",
    measures: [
      buildKeywordMeasure(input.keywords),
      buildRequirementMeasure(input.requirements),
      buildDocumentChecksMeasure(input.checks),
      buildEvidenceMeasure(input.evidence),
    ],
  });
}

/** Percent for display (assessed sides only); null when not assessed. */
export function assessmentPercent(side: MeasureSide): number | null {
  if (side.status !== "assessed") {
    return null;
  }
  return Math.round((100 * side.numerator) / side.denominator);
}

/**
 * Point delta between two assessed sides over the same eligible
 * set; null unless both sides are assessed. No composite score.
 */
export function assessmentDelta(
  original: MeasureSide,
  tailored: MeasureSide,
): number | null {
  const a = assessmentPercent(original);
  const b = assessmentPercent(tailored);
  return a === null || b === null ? null : b - a;
}
