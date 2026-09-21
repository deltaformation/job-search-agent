import {
  FocusV1 as FocusSchema,
  RecommendationV1 as RecommendationSchema,
  type FocusV1,
  type RecommendationV1,
} from "../domain/tailoringWorkspace";
import { evaluateDirectiveOutcomes } from "./directives";
import type { CandidateProfileInput } from "./schemas";
import {
  evaluateKeywordSupport,
  type KeywordSupport,
  type SupportEvidence,
} from "./support";
import { compareCodePoints, hasWordBoundary, normalizeTerm } from "./text";

/**
 * v1.3 focus-steering compiler adapter (contracts §3.2, WO-1.3-E).
 *
 * Pure functions over frozen inputs: the approved profile, the exact
 * focus draft, and its recommendation snapshot. Ranking steering only
 * reorders the ranker's eligible output — mapped eligible facts first,
 * then selected-term eligible facts, then the existing stable rank —
 * preserving every section budget and introducing no claim or template
 * path. Summary direction never edits generated text: exact approved
 * wording can report `used`, supported-but-unrendered requests report
 * `omitted-by-budget` or `not-assessed`, and unbacked wording becomes
 * an explicit `summary-{index}` gap that generated content omits by
 * construction.
 */

export const FOCUS_STEERING_POLICY_VERSION = "focus-steering/v1";
export const FOCUS_SUMMARY_GAP_PREFIX = "summary-";

export type FocusOutcomeStatus = "used" | "omitted-by-budget" | "unsupported" | "not-assessed";

export interface FocusSteeringOutcome {
  field: "mappings" | "selectedPhraseIds" | "themeId" | "summaryDirection";
  mappingIndex?: number;
  phraseId?: string;
  outcome: FocusOutcomeStatus;
  requirementIds: string[];
  evidenceFactIds: string[];
  detail: string;
}

export interface FocusRunRequirement {
  requirementId: string;
  jdQuote: string;
  matchStatus: string;
  evidenceFactIds: string[];
}

export interface FocusRunGap {
  requirementId: string;
  jdQuote: string;
  matchStatus: string;
  category?: string;
}

interface ApprovedEvidence {
  factId: string;
  text: string;
  support: SupportEvidence;
  factText: string;
  blob: string;
}

function approvedEvidence(profile: CandidateProfileInput): ApprovedEvidence[] {
  return profile.verified_facts
    .filter((fact) => fact.verification_status === "approved")
    .map((fact) => {
      const factText = [fact.text, ...fact.metrics, ...fact.technologies].join("\n");
      return {
        factId: fact.fact_id,
        text: fact.text,
        support: {
          factId: fact.fact_id,
          statement: fact.text,
          evidenceJson: JSON.stringify({ metrics: fact.metrics, technologies: fact.technologies }),
        },
        factText,
        blob: normalizeTerm(factText),
      };
    });
}

function sortedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort(compareCodePoints);
}

function phraseRelates(quote: string, phraseText: string): boolean {
  const term = normalizeTerm(phraseText);
  if (term === "") {
    return false;
  }
  return hasWordBoundary(term, normalizeTerm(quote));
}

function jdContains(jdText: string, phraseText: string): boolean {
  return jdText.toLowerCase().includes(phraseText.toLowerCase());
}

function supportedRequirements(
  requirements: FocusRunRequirement[],
): FocusRunRequirement[] {
  return requirements.filter(
    (requirement) =>
      requirement.matchStatus === "matched" || requirement.matchStatus === "partial",
  );
}

function providerGaps(gaps: FocusRunGap[]): FocusRunGap[] {
  return gaps.filter(
    (gap) =>
      gap.category !== "directive" &&
      gap.category !== "summary" &&
      !gap.requirementId.startsWith("directive-") &&
      !gap.requirementId.startsWith(FOCUS_SUMMARY_GAP_PREFIX),
  );
}

function requirementIdsForFacts(
  requirements: FocusRunRequirement[],
  factIds: ReadonlySet<string>,
): string[] {
  return sortedIds(
    supportedRequirements(requirements)
      .filter((requirement) =>
        requirement.evidenceFactIds.some((factId) => factIds.has(factId)),
      )
      .map((requirement) => requirement.requirementId),
  );
}

function relatedRequirementIds(
  phraseText: string,
  requirements: FocusRunRequirement[],
  gaps: FocusRunGap[],
): { supported: FocusRunRequirement[]; gaps: FocusRunGap[]; ids: string[] } {
  const relatedSupported = supportedRequirements(requirements).filter((requirement) =>
    phraseRelates(requirement.jdQuote, phraseText),
  );
  const relatedGaps = providerGaps(gaps).filter((gap) => phraseRelates(gap.jdQuote, phraseText));
  return {
    supported: relatedSupported,
    gaps: relatedGaps,
    ids: sortedIds([
      ...relatedSupported.map((requirement) => requirement.requirementId),
      ...relatedGaps.map((gap) => gap.requirementId),
    ]),
  };
}

function validatedFocusPair(
  focus: FocusV1,
  recommendations: RecommendationV1,
): { focus: FocusV1; recommendations: RecommendationV1 } | null {
  const parsedFocus = FocusSchema.safeParse(focus);
  const parsedRecommendations = RecommendationSchema.safeParse(recommendations);
  if (!parsedFocus.success || !parsedRecommendations.success) {
    return null;
  }
  return { focus: parsedFocus.data, recommendations: parsedRecommendations.data };
}

export function orderRankedFactsWithFocus(input: {
  rankedFactIds: string[];
  profile: CandidateProfileInput;
  focus: FocusV1;
  recommendations: RecommendationV1;
}): { rankedFactIds: string[] } {
  const pair = validatedFocusPair(input.focus, input.recommendations);
  if (pair === null) {
    return { rankedFactIds: [...input.rankedFactIds] };
  }
  const approved = new Set(
    input.profile.verified_facts
      .filter((fact) => fact.verification_status === "approved")
      .map((fact) => fact.fact_id),
  );
  const roles = new Map(pair.recommendations.roles.map((role) => [role.id, role]));
  const phrases = new Map(pair.recommendations.phrases.map((phrase) => [phrase.id, phrase]));
  const mapped = new Set<string>();
  for (const mapping of pair.focus.mappings) {
    const role = roles.get(mapping.roleId);
    if (role === undefined || !phrases.has(mapping.phraseId)) {
      continue;
    }
    const owned = new Set(role.factIds);
    for (const factId of mapping.factIds) {
      if (owned.has(factId) && approved.has(factId)) {
        mapped.add(factId);
      }
    }
  }
  const selected = new Set<string>();
  for (const phraseId of pair.focus.selectedPhraseIds) {
    const phrase = phrases.get(phraseId);
    if (phrase === undefined || phrase.support !== "supported") {
      continue;
    }
    for (const factId of phrase.factIds) {
      if (approved.has(factId) && !mapped.has(factId)) {
        selected.add(factId);
      }
    }
  }
  const legacyIndex = new Map(input.rankedFactIds.map((factId, index) => [factId, index]));
  const categoryOf = (factId: string): number => {
    if (mapped.has(factId)) {
      return 0;
    }
    if (selected.has(factId)) {
      return 1;
    }
    return 2;
  };
  return {
    rankedFactIds: [...input.rankedFactIds].sort(
      (left, right) =>
        categoryOf(left) - categoryOf(right) ||
        (legacyIndex.get(left) ?? 0) - (legacyIndex.get(right) ?? 0) ||
        compareCodePoints(left, right),
    ),
  };
}

function splitSummarySentences(summaryDirection: string): string[] {
  const sentences: string[] = [];
  for (const line of summaryDirection.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    const matches = trimmed.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [];
    for (const match of matches) {
      const sentence = match.trim();
      if (sentence !== "") {
        sentences.push(sentence);
      }
    }
  }
  return sentences;
}

function looksTechnical(token: string): boolean {
  if (/\d/.test(token) || /[+#./]/.test(token)) {
    return true;
  }
  return /[A-Z].*[A-Z]/.test(token) || /^[A-Z0-9]{2,}$/.test(token);
}

function stripTokenPunctuation(token: string): string {
  return token.replace(/^['"“”‘’`([{<]+|['"”’`)}\].,;:!?…>]+$/g, "");
}

function extractUnbackedTechnicalTokens(sentence: string, blobs: string[]): string[] {
  const seen = new Set<string>();
  const unbacked: string[] = [];
  for (const raw of sentence.split(/\s+/)) {
    const token = stripTokenPunctuation(raw);
    if (token.length < 3 || !looksTechnical(token)) {
      continue;
    }
    const normalized = normalizeTerm(token);
    if (normalized === "" || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const backed = blobs.some((blob) => blob !== "" && hasWordBoundary(normalized, blob));
    if (!backed) {
      unbacked.push(token.slice(0, 64));
    }
  }
  return unbacked;
}

export interface SummarySentenceAssessment {
  index: number;
  sentence: string;
  exactBaseline: boolean;
  exactFactId: string | null;
  support: KeywordSupport;
  unbackedKpiTokens: string[];
  unbackedTechnicalTokens: string[];
  unsupported: boolean;
}

export function assessSummarySentences(input: {
  profile: CandidateProfileInput;
  summaryDirection: string;
}): SummarySentenceAssessment[] {
  const evidence = approvedEvidence(input.profile);
  const baseline = (input.profile.summary ?? "").trim();
  const factTextById = new Map(evidence.map((entry) => [entry.factId, entry.text]));
  const blobs = evidence.map((entry) => entry.blob);
  const factTexts = evidence.map((entry) => entry.factText);
  return splitSummarySentences(input.summaryDirection).map((sentence, index) => {
    const exactBaseline = baseline !== "" && sentence === baseline;
    const exactFactId =
      [...factTextById.entries()].find(([, text]) => text !== "" && text === sentence)?.[0] ??
      null;
    const support = evaluateKeywordSupport(
      [sentence],
      evidence.map((entry) => entry.support),
    )[0] as KeywordSupport;
    const directive = evaluateDirectiveOutcomes(sentence, factTexts)[0];
    const unbackedKpiTokens =
      directive !== undefined && directive.status === "unsupported"
        ? [...directive.unbackedTokens]
        : [];
    const unbackedTechnicalTokens = extractUnbackedTechnicalTokens(sentence, blobs);
    const unsupported =
      !exactBaseline &&
      exactFactId === null &&
      (unbackedKpiTokens.length > 0 ||
        unbackedTechnicalTokens.length > 0 ||
        (normalizeTerm(sentence) !== "" && support.status === "gap"));
    return {
      index,
      sentence,
      exactBaseline,
      exactFactId,
      support,
      unbackedKpiTokens,
      unbackedTechnicalTokens,
      unsupported,
    };
  });
}

export interface SummaryGapDraft {
  requirementId: string;
  sentence: string;
  explanation: string;
}

function wholeDirectionMatchesApproved(
  profile: CandidateProfileInput,
  summaryDirection: string,
): boolean {
  const trimmed = summaryDirection.trim();
  if (trimmed === "") {
    return true;
  }
  const baseline = (profile.summary ?? "").trim();
  if (baseline !== "" && trimmed === baseline) {
    return true;
  }
  return profile.verified_facts.some(
    (fact) =>
      fact.verification_status === "approved" && fact.text !== "" && fact.text === trimmed,
  );
}

export function summaryGapDrafts(input: {
  profile: CandidateProfileInput;
  summaryDirection: string;
}): SummaryGapDraft[] {
  if (input.summaryDirection.trim() === "") {
    return [];
  }
  if (wholeDirectionMatchesApproved(input.profile, input.summaryDirection)) {
    return [];
  }
  return assessSummarySentences(input)
    .filter((assessment) => assessment.unsupported)
    .map((assessment) => {
      const tokens = [...assessment.unbackedKpiTokens, ...assessment.unbackedTechnicalTokens];
      return {
        requirementId: `${FOCUS_SUMMARY_GAP_PREFIX}${assessment.index}`,
        sentence: assessment.sentence.slice(0, 280),
        explanation:
          tokens.length > 0
            ? `Requested summary wording names ${tokens.map((token) => `"${token}"`).join(", ")}, which no approved fact backs; the tailored resume omits this sentence and records it as an unsupported gap.`
            : "Requested summary wording is not an approved summary statement; the tailored resume omits this sentence and records it as an unsupported gap.",
      };
    });
}

function mappingHonoredFacts(
  mapping: FocusV1["mappings"][number],
  roles: Map<string, RecommendationV1["roles"][number]>,
  phrases: Map<string, RecommendationV1["phrases"][number]>,
  approved: ReadonlySet<string>,
): { honored: string[]; valid: boolean } {
  const role = roles.get(mapping.roleId);
  const phrase = phrases.get(mapping.phraseId);
  if (role === undefined || phrase === undefined) {
    return { honored: [], valid: false };
  }
  const owned = new Set(role.factIds);
  const honored = sortedIds(mapping.factIds.filter((factId) => owned.has(factId) && approved.has(factId)));
  return { honored, valid: honored.length > 0 };
}

export function evaluateFocusOutcomes(input: {
  profile: CandidateProfileInput;
  focus: FocusV1;
  recommendations: RecommendationV1;
  requirements: FocusRunRequirement[];
  gaps: FocusRunGap[];
  rankedFactIds: string[];
  citedFactIds: string[];
  renderedSummaryText: string;
  summaryFactIds: string[];
  jdText: string;
}): FocusSteeringOutcome[] {
  const pair = validatedFocusPair(input.focus, input.recommendations);
  if (pair === null) {
    return [];
  }
  const outcomes: FocusSteeringOutcome[] = [];
  const approved = new Set(
    input.profile.verified_facts
      .filter((fact) => fact.verification_status === "approved")
      .map((fact) => fact.fact_id),
  );
  const cited = new Set(input.citedFactIds);
  const ranked = new Set(input.rankedFactIds);
  const roles = new Map(pair.recommendations.roles.map((role) => [role.id, role]));
  const phrases = new Map(pair.recommendations.phrases.map((phrase) => [phrase.id, phrase]));

  pair.focus.mappings.forEach((mapping, mappingIndex) => {
    const phrase = phrases.get(mapping.phraseId);
    const { honored, valid } = mappingHonoredFacts(mapping, roles, phrases, approved);
    if (!valid || phrase === undefined) {
      outcomes.push({
        field: "mappings",
        mappingIndex,
        phraseId: mapping.phraseId,
        outcome: "unsupported",
        requirementIds: [],
        evidenceFactIds: [],
        detail:
          "Mapped facts must be approved facts owned by the mapped role; this mapping steered nothing.",
      });
      return;
    }
    const citedHonored = sortedIds(honored.filter((factId) => cited.has(factId)));
    const related = relatedRequirementIds(phrase.text, input.requirements, input.gaps);
    if (citedHonored.length > 0) {
      outcomes.push({
        field: "mappings",
        mappingIndex,
        phraseId: mapping.phraseId,
        outcome: "used",
        requirementIds: related.ids,
        evidenceFactIds: citedHonored,
        detail: "The run rendered evidence for this mapping.",
      });
    } else if (related.supported.length > 0) {
      outcomes.push({
        field: "mappings",
        mappingIndex,
        phraseId: mapping.phraseId,
        outcome: "omitted-by-budget",
        requirementIds: related.ids,
        evidenceFactIds: sortedIds(
          related.supported.flatMap((requirement) =>
            requirement.evidenceFactIds.filter((factId) => honored.includes(factId)),
          ),
        ),
        detail:
          "Supported by profile facts, but the run rendered nothing for it — the evidence budget went elsewhere.",
      });
    } else if (related.gaps.length > 0) {
      outcomes.push({
        field: "mappings",
        mappingIndex,
        phraseId: mapping.phraseId,
        outcome: "unsupported",
        requirementIds: related.ids,
        evidenceFactIds: [],
        detail: "No profile facts back this mapped phrase — honestly kept off the resume.",
      });
    } else {
      outcomes.push({
        field: "mappings",
        mappingIndex,
        phraseId: mapping.phraseId,
        outcome: jdContains(input.jdText, phrase.text) ? "not-assessed" : "unsupported",
        requirementIds: [],
        evidenceFactIds: [],
        detail: jdContains(input.jdText, phrase.text)
          ? "In the description, but the analysis did not evaluate it — it steered ranking only."
          : "Not in the job description — nothing to assess.",
      });
    }
  });

  for (const phraseId of pair.focus.selectedPhraseIds) {
    const phrase = phrases.get(phraseId);
    if (phrase === undefined || phrase.support !== "supported") {
      outcomes.push({
        field: "selectedPhraseIds",
        phraseId,
        outcome: "unsupported",
        requirementIds: [],
        evidenceFactIds: [],
        detail:
          "Only supported phrases with approved facts can be selected; this selection steered nothing.",
      });
      continue;
    }
    const support = sortedIds(phrase.factIds.filter((factId) => approved.has(factId)));
    if (support.length === 0) {
      outcomes.push({
        field: "selectedPhraseIds",
        phraseId,
        outcome: "unsupported",
        requirementIds: [],
        evidenceFactIds: [],
        detail: "No approved facts back this selected phrase — honestly kept off the resume.",
      });
      continue;
    }
    const citedSupport = sortedIds(support.filter((factId) => cited.has(factId)));
    const related = relatedRequirementIds(phrase.text, input.requirements, input.gaps);
    if (citedSupport.length > 0) {
      outcomes.push({
        field: "selectedPhraseIds",
        phraseId,
        outcome: "used",
        requirementIds: related.ids,
        evidenceFactIds: citedSupport,
        detail: "The run rendered evidence for this term.",
      });
    } else if (related.supported.length > 0) {
      outcomes.push({
        field: "selectedPhraseIds",
        phraseId,
        outcome: "omitted-by-budget",
        requirementIds: related.ids,
        evidenceFactIds: sortedIds(
          related.supported.flatMap((requirement) =>
            requirement.evidenceFactIds.filter((factId) => support.includes(factId)),
          ),
        ),
        detail:
          "Supported by profile facts, but the run rendered nothing for it — the evidence budget went elsewhere.",
      });
    } else if (related.gaps.length > 0) {
      outcomes.push({
        field: "selectedPhraseIds",
        phraseId,
        outcome: "unsupported",
        requirementIds: related.ids,
        evidenceFactIds: [],
        detail: "No profile facts back this term — honestly kept off the resume.",
      });
    } else {
      outcomes.push({
        field: "selectedPhraseIds",
        phraseId,
        outcome: jdContains(input.jdText, phrase.text) ? "not-assessed" : "unsupported",
        requirementIds: [],
        evidenceFactIds: [],
        detail: jdContains(input.jdText, phrase.text)
          ? "In the description, but the analysis did not evaluate it — it steered ranking only."
          : "Not in the job description — nothing to assess.",
      });
    }
  }

  if (pair.focus.themeId !== null) {
    const theme = pair.recommendations.themes.find((entry) => entry.id === pair.focus.themeId);
    if (theme === undefined) {
      outcomes.push({
        field: "themeId",
        outcome: "unsupported",
        requirementIds: [],
        evidenceFactIds: [],
        detail: "Theme is not in the bound recommendation snapshot; it steered nothing.",
      });
    } else {
      const support = new Set(theme.factIds.filter((factId) => approved.has(factId)));
      const citedTheme = sortedIds([...support].filter((factId) => cited.has(factId)));
      const linkedRequirementIds = requirementIdsForFacts(input.requirements, support);
      if (citedTheme.length > 0) {
        outcomes.push({
          field: "themeId",
          outcome: "used",
          requirementIds: linkedRequirementIds,
          evidenceFactIds: citedTheme,
          detail: "The run rendered evidence for this theme.",
        });
      } else if (
        linkedRequirementIds.length > 0 ||
        [...support].some((factId) => ranked.has(factId))
      ) {
        outcomes.push({
          field: "themeId",
          outcome: "omitted-by-budget",
          requirementIds: linkedRequirementIds,
          evidenceFactIds: sortedIds(
            supportedRequirements(input.requirements).flatMap((requirement) =>
              requirement.evidenceFactIds.filter((factId) => support.has(factId)),
            ),
          ),
          detail:
            "Supported by profile facts, but the run rendered nothing for it — the evidence budget went elsewhere.",
        });
      } else if (support.size > 0) {
        outcomes.push({
          field: "themeId",
          outcome: "not-assessed",
          requirementIds: [],
          evidenceFactIds: [],
          detail: "Theme facts steered ranking only; the analysis did not evaluate them.",
        });
      } else {
        outcomes.push({
          field: "themeId",
          outcome: "unsupported",
          requirementIds: [],
          evidenceFactIds: [],
          detail: "No approved facts back this theme — honestly kept off the resume.",
        });
      }
    }
  }

  const direction = pair.focus.summaryDirection;
  if (direction.trim() !== "") {
    if (wholeDirectionMatchesApproved(input.profile, direction)) {
      const rendered = input.renderedSummaryText.includes(direction.trim());
      outcomes.push({
        field: "summaryDirection",
        outcome: rendered ? "used" : "omitted-by-budget",
        requirementIds: [],
        evidenceFactIds: sortedIds(input.summaryFactIds),
        detail: rendered
          ? "The run rendered this approved summary wording."
          : "Approved summary wording, but the run rendered other evidence — the summary budget went elsewhere.",
      });
    } else {
      for (const assessment of assessSummarySentences({ profile: input.profile, summaryDirection: direction })) {
        if (assessment.exactBaseline || assessment.exactFactId !== null) {
          const rendered = input.renderedSummaryText.includes(assessment.sentence);
          outcomes.push({
            field: "summaryDirection",
            outcome: rendered ? "used" : "omitted-by-budget",
            requirementIds: [],
            evidenceFactIds:
              assessment.exactFactId !== null
                ? [assessment.exactFactId]
                : sortedIds(input.summaryFactIds),
            detail: rendered
              ? "The run rendered this approved summary sentence."
              : "Approved summary wording, but the run rendered other evidence — the summary budget went elsewhere.",
          });
        } else if (assessment.unsupported) {
          outcomes.push({
            field: "summaryDirection",
            outcome: "unsupported",
            requirementIds: [`${FOCUS_SUMMARY_GAP_PREFIX}${assessment.index}`],
            evidenceFactIds: [],
            detail:
              "Requested summary wording is not backed by approved facts — honestly kept off the resume.",
          });
        } else {
          const contributing = new Set(assessment.support.factIds);
          outcomes.push({
            field: "summaryDirection",
            outcome: "not-assessed",
            requirementIds: requirementIdsForFacts(input.requirements, contributing),
            evidenceFactIds: sortedIds(assessment.support.factIds),
            detail:
              "The compiler cannot assess this requested paraphrase — it steered ranking only.",
          });
        }
      }
    }
  }

  return outcomes;
}
