import { splitDirectiveLines } from "./directives";
import { compareCodePoints, hasWordBoundary, normalizeTerm } from "./text";

/**
 * Requested-emphasis coaching outcomes (WO-1.2-E). Pure derivation from
 * STORED run data only — the bound generation request (selected
 * keywords, directives), the persisted requirements/gaps, the stored
 * claims, and the pinned JD text. Nothing is inferred from the live
 * profile or the current JD: coaching explains what a finished run
 * did with the emphasis it was given.
 *
 * Term outcomes:
 * - used: a related supported requirement rendered ≥1 stored claim.
 * - omitted-by-budget: related requirements are supported but
 *   rendered nothing — the run's evidence budget went elsewhere.
 * - unsupported: every related requirement is a gap/unsupported with
 *   no backing facts — honestly kept off the resume.
 * - not-applicable: the term is not a JD substring (legacy or forged
 *   rows predate server validation) — nothing to assess.
 * - not-assessed: a JD substring the analysis never extracted — it
 *   steered ranking only.
 *
 * A term relates to a requirement when the normalized term appears in
 * the normalized JD quote with word boundaries (so "go-to-market"
 * matches "go to market" and "CI/CD" matches "ci cd"). Directive
 * gaps (`directive-{index}`) never relate to terms; per-line
 * directive outcomes come from the stored directive gaps instead.
 *
 * `COACHING_OUTCOMES_VERSION` versions this selection policy in the
 * review lineage: outcomes must never be silently recomputed under a
 * changed rule.
 */

export const COACHING_OUTCOMES_VERSION = "keyword-coaching/v1";

export type TermOutcomeStatus =
  | "used"
  | "omitted-by-budget"
  | "unsupported"
  | "not-applicable"
  | "not-assessed";

export interface CoachingRequirement {
  requirementId: string;
  jdQuote: string;
  matchStatus: string;
}

export interface CoachingClaim {
  requirementRef: string | null;
}

export interface TermCoachingOutcome {
  term: string;
  outcome: TermOutcomeStatus;
  requirementIds: string[];
  evidenceFactIds: string[];
  detail: string;
}

export type DirectiveOutcomeStatus = "used" | "unsupported" | "not-assessed";

export interface DirectiveCoachingOutcome {
  index: number;
  directive: string;
  outcome: DirectiveOutcomeStatus;
  explanation: string | null;
}

function jdContains(jdText: string, term: string): boolean {
  return jdText.toLowerCase().includes(term.toLowerCase());
}

function quoteRelates(quote: string, term: string): boolean {
  const normalizedTerm = normalizeTerm(term);
  if (normalizedTerm === "") {
    return false;
  }
  return hasWordBoundary(normalizedTerm, normalizeTerm(quote));
}

export function evaluateTermOutcomes(input: {
  selectedKeywords: string[];
  /** Supported requirements with their evidence fact ids. */
  requirements: Array<CoachingRequirement & { evidenceFactIds: string[] }>;
  /** Non-directive gaps (directive gaps belong to directive outcomes). */
  gaps: CoachingRequirement[];
  claims: CoachingClaim[];
  jdText: string;
}): TermCoachingOutcome[] {
  return input.selectedKeywords.map((term) => {
    const relatedSupported = input.requirements.filter((requirement) =>
      quoteRelates(requirement.jdQuote, term),
    );
    const relatedGaps = input.gaps.filter((gap) => quoteRelates(gap.jdQuote, term));
    if (relatedSupported.length === 0 && relatedGaps.length === 0) {
      return jdContains(input.jdText, term)
        ? {
            term,
            outcome: "not-assessed",
            requirementIds: [],
            evidenceFactIds: [],
            detail: "In the description, but the analysis did not evaluate it — it steered ranking only.",
          }
        : {
            term,
            outcome: "not-applicable",
            requirementIds: [],
            evidenceFactIds: [],
            detail: "Not in the job description — nothing to assess.",
          };
    }
    const requirementIds = [...relatedSupported, ...relatedGaps]
      .map((entry) => entry.requirementId)
      .sort(compareCodePoints);
    const claimed = relatedSupported.filter((requirement) =>
      input.claims.some((claim) => claim.requirementRef === requirement.requirementId),
    );
    if (claimed.length > 0) {
      const evidenceFactIds = [...new Set(claimed.flatMap((entry) => entry.evidenceFactIds))].sort(
        compareCodePoints,
      );
      return {
        term,
        outcome: "used",
        requirementIds,
        evidenceFactIds,
        detail: "The run rendered evidence for this term.",
      };
    }
    if (relatedSupported.length > 0) {
      const evidenceFactIds = [
        ...new Set(relatedSupported.flatMap((entry) => entry.evidenceFactIds)),
      ].sort(compareCodePoints);
      return {
        term,
        outcome: "omitted-by-budget",
        requirementIds,
        evidenceFactIds,
        detail:
          "Supported by profile facts, but the run rendered nothing for it — the evidence budget went elsewhere.",
      };
    }
    return {
      term,
      outcome: "unsupported",
      requirementIds,
      evidenceFactIds: [],
      detail: "No profile facts back this term — honestly kept off the resume.",
    };
  });
}

export function evaluateDirectiveOutcomes(input: {
  /** Stored directives text; null when the request recorded none. */
  directivesText: string | null;
  /** Persisted `directive-{index}` gaps with their explanations. */
  directiveGaps: Array<{ requirementId: string; explanation: string | null }>;
}): { recorded: boolean; outcomes: DirectiveCoachingOutcome[] } {
  if (input.directivesText === null) {
    return { recorded: false, outcomes: [] };
  }
  const gapsByIndex = new Map<number, string | null>();
  for (const gap of input.directiveGaps) {
    const match = /^directive-(\d+)$/.exec(gap.requirementId);
    if (match?.[1] !== undefined) {
      gapsByIndex.set(Number(match[1]), gap.explanation);
    }
  }
  return {
    recorded: true,
    outcomes: splitDirectiveLines(input.directivesText).map((directive, index) =>
      gapsByIndex.has(index)
        ? {
            index,
            directive: directive.slice(0, 280),
            outcome: "unsupported",
            explanation: gapsByIndex.get(index) ?? null,
          }
        : {
            index,
            directive: directive.slice(0, 280),
            outcome: "used",
            explanation: null,
          },
    ),
  };
}
