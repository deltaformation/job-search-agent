import { atsKeywordCategory, extractAtsKeywords } from "../domain/atsKeywords";
import type { StoredProfilePayload } from "../domain/candidate";
import { canonicalText, truncateCodePoints } from "../domain/canonical";
import {
  RecommendationV1,
  SELECTABLE_TERM_MAX_CHARS,
  type RecommendationV1 as RecommendationV1Type,
} from "../domain/tailoringWorkspace";
import { extractUtf8ByteRange, phraseIdFor } from "./requestsV3";
import { evaluateKeywordSupport, type SupportEvidence } from "./support";
import { compareCodePoints } from "./text";

/**
 * Deterministic recommendation builder (WO-1.3-D, contracts §3.1).
 * Pure function of the retained canonical JD, the immutable profile
 * payload, and that version's APPROVED facts: no provider calls, no
 * clock, no I/O. Same inputs byte-compare equal, always.
 *
 * Construction rules (each pinned by the D3/D4 specs):
 *
 * - Phrases come from `extractAtsKeywords` over the canonical JD
 *   (≤100 cloud candidates, never padded). The extractor reports
 *   UTF-16 offsets; ranges are converted to UTF-8 bytes and the
 *   exact decoded slice becomes the phrase text. A range that fails
 *   closed (out of bounds, split code point, or folded mismatch
 *   against the matched keyword) drops that phrase — a citation is
 *   never emitted for bytes it does not select.
 * - Phrase IDs are `phraseIdFor` over the canonical
 *   extraction/offset/text tuple; counts are the extractor's
 *   case-folded boundary-checked occurrence counts; categories come
 *   from the fixed `atsKeywordCategory` dictionary (Other fallback).
 * - Support is `evaluateKeywordSupport` against APPROVED facts only
 *   (the caller filters verification state). Phrase text over 512
 *   characters is skipped: such blobs are pathological tokenizer
 *   output, not citable phrases.
 * - Roles mirror payload employment order. IDs are the immutable
 *   payload employment keys; fact IDs are the role's approved facts
 *   in code-point order. Labels carry role, company, and dates.
 * - Themes group approved facts by achievement category in
 *   first-appearance order (categories are the author's own
 *   groupings, ≤80 chars verbatim). Every theme shares the default
 *   summary direction: the canonical master summary when the payload
 *   carries one, else the approved statements joined in fact-ID
 *   order.
 * - The preset selects supported phrases with approved facts whose
 *   text fits the 128-character selection cap, in phrase order (≤20).
 *   Each selected phrase maps to the first employment role (payload
 *   order) owning at least one of its support facts; phrases with no
 *   role-owned support stay selected but unmapped. The preset theme
 *   is the theme with the most approved facts (first-appearance
 *   tiebreak), or null when no theme exists. Guidance starts empty.
 *
 * Schema bounds truncate derived fact-ID lists and display text
 * deterministically (code-point order / code-point prefix); user
 * guidance is never truncated — over-limit input fails 400.
 */

export const RECOMMENDATION_PHRASE_LIMIT = 100;
export const RECOMMENDATION_PHRASE_TEXT_MAX_CHARS = 512;
export const RECOMMENDATION_SELECTED_LIMIT = 20;
export const RECOMMENDATION_FACT_IDS_LIMIT = 100;
export const RECOMMENDATION_MAPPING_FACT_IDS_LIMIT = 20;
export const RECOMMENDATION_THEME_LIMIT = 10;
export const RECOMMENDATION_SUMMARY_MAX_CHARS = 4000;
export const RECOMMENDATION_ROLE_LABEL_MAX_CHARS = 200;

export interface RecommendationBuildInput {
  extractionId: string;
  /** Canonical JD bytes: `canonicalText` of the retained extraction description. */
  canonicalJdText: string;
  jdHash: string;
  profileVersionId: string;
  profileHash: string;
  payload: StoredProfilePayload;
  /** APPROVED facts of this version (statement + raw evidence). */
  approvedFacts: SupportEvidence[];
}

interface BuiltPhrase {
  id: string;
  text: string;
  startByte: number;
  endByte: number;
  excerpt: string;
  count: number;
  category: string;
  support: "supported" | "uncertain" | "gap";
  factIds: string[];
}

function roleLabelFor(employment: {
  role: string;
  company: string;
  startDate: string;
  endDate?: string;
  isCurrent: boolean;
}): string {
  const span = employment.isCurrent ? "present" : (employment.endDate as string);
  return truncateCodePoints(
    `${employment.role} @ ${employment.company} (${employment.startDate} – ${span})`,
    RECOMMENDATION_ROLE_LABEL_MAX_CHARS,
  );
}

export function buildRecommendations(input: RecommendationBuildInput): RecommendationV1Type {
  const keywords = extractAtsKeywords(input.canonicalJdText, RECOMMENDATION_PHRASE_LIMIT);
  const supportByKeyword = new Map(
    evaluateKeywordSupport(
      keywords.map((entry) => entry.keyword),
      input.approvedFacts,
    ).map((entry) => [entry.keyword, entry]),
  );

  const phrases: BuiltPhrase[] = [];
  for (const entry of keywords) {
    if (entry.keyword.length > RECOMMENDATION_PHRASE_TEXT_MAX_CHARS) {
      continue;
    }
    // Extractor offsets are UTF-16 indices into the scanned (canonical)
    // text; the matched occurrence is ASCII, so its byte length equals
    // its char length. The decoded slice must fold-equal the keyword
    // or the phrase is dropped — never a misaligned citation.
    const startByte = Buffer.byteLength(input.canonicalJdText.slice(0, entry.offset), "utf8");
    const endByte = startByte + entry.keyword.length;
    const slice = extractUtf8ByteRange(input.canonicalJdText, startByte, endByte);
    if (slice === null || slice.toLowerCase() !== entry.keyword.toLowerCase()) {
      continue;
    }
    const support = supportByKeyword.get(entry.keyword) ?? {
      keyword: entry.keyword,
      status: "gap" as const,
      factIds: [],
    };
    phrases.push({
      id: phraseIdFor({
        extractionId: input.extractionId,
        jdHash: input.jdHash,
        startByte,
        endByte,
        text: slice,
      }),
      text: slice,
      startByte,
      endByte,
      excerpt: entry.excerpt,
      count: entry.count,
      category: atsKeywordCategory(entry.keyword),
      support: support.status,
      factIds: [...support.factIds]
        .sort(compareCodePoints)
        .slice(0, RECOMMENDATION_FACT_IDS_LIMIT),
    });
  }

  const approvedIds = new Set(input.approvedFacts.map((fact) => fact.factId));
  const employmentOf = new Map<string, string>();
  const categoryOf = new Map<string, string>();
  for (const achievement of input.payload.achievements) {
    if (achievement.employmentId !== undefined) {
      employmentOf.set(achievement.factId, achievement.employmentId);
    }
    categoryOf.set(achievement.factId, achievement.category);
  }

  const roleOwnedFacts = new Map<string, string[]>();
  for (const employment of input.payload.employment) {
    roleOwnedFacts.set(employment.id, []);
  }
  for (const factId of approvedIds) {
    const roleId = employmentOf.get(factId);
    if (roleId !== undefined && roleOwnedFacts.has(roleId)) {
      (roleOwnedFacts.get(roleId) as string[]).push(factId);
    }
  }
  const roles = input.payload.employment.map((employment) => ({
    id: employment.id,
    label: roleLabelFor(employment),
    factIds: [...(roleOwnedFacts.get(employment.id) as string[])]
      .sort(compareCodePoints)
      .slice(0, RECOMMENDATION_FACT_IDS_LIMIT),
  }));

  const themeOrder: string[] = [];
  const themeFacts = new Map<string, string[]>();
  for (const achievement of input.payload.achievements) {
    if (!approvedIds.has(achievement.factId)) {
      continue;
    }
    const category = achievement.category;
    if (!themeFacts.has(category)) {
      themeFacts.set(category, []);
      themeOrder.push(category);
    }
    (themeFacts.get(category) as string[]).push(achievement.factId);
  }

  const defaultSummary =
    input.payload.summary !== undefined
      ? truncateCodePoints(canonicalText(input.payload.summary), RECOMMENDATION_SUMMARY_MAX_CHARS)
      : truncateCodePoints(
          [...approvedIds]
            .sort(compareCodePoints)
            .map(
              (factId) =>
                input.approvedFacts.find((fact) => fact.factId === factId)?.statement ?? "",
            )
            .filter((statement) => statement !== "")
            .join("\n"),
          RECOMMENDATION_SUMMARY_MAX_CHARS,
        );

  const themes = themeOrder.slice(0, RECOMMENDATION_THEME_LIMIT).map((category) => ({
    id: category,
    title: category,
    factIds: [...(themeFacts.get(category) as string[])]
      .sort(compareCodePoints)
      .slice(0, RECOMMENDATION_FACT_IDS_LIMIT),
    summaryDirection: defaultSummary,
  }));

  const selectable = phrases.filter(
    (phrase) =>
      phrase.support === "supported" &&
      phrase.factIds.length > 0 &&
      phrase.text.length <= SELECTABLE_TERM_MAX_CHARS,
  );
  const selectedPhraseIds = selectable
    .slice(0, RECOMMENDATION_SELECTED_LIMIT)
    .map((phrase) => phrase.id);
  const selectedSet = new Set(selectedPhraseIds);
  const mappings: Array<{ roleId: string; phraseId: string; factIds: string[] }> = [];
  for (const phrase of selectable) {
    if (!selectedSet.has(phrase.id)) {
      continue;
    }
    const phraseFacts = new Set(phrase.factIds);
    for (const employment of input.payload.employment) {
      const shared = [...(roleOwnedFacts.get(employment.id) as string[])]
        .filter((factId) => phraseFacts.has(factId))
        .sort(compareCodePoints)
        .slice(0, RECOMMENDATION_MAPPING_FACT_IDS_LIMIT);
      if (shared.length > 0) {
        mappings.push({ roleId: employment.id, phraseId: phrase.id, factIds: shared });
        break;
      }
    }
  }

  let presetThemeId: string | null = null;
  let presetThemeCount = 0;
  for (const theme of themes) {
    if (theme.factIds.length > presetThemeCount) {
      presetThemeCount = theme.factIds.length;
      presetThemeId = theme.id;
    }
  }

  // Fail closed: the builder guarantees schema-valid output; a throw
  // here is an internal invariant break, never unchecked bytes.
  return RecommendationV1.parse({
    schemaVersion: "tailoring-recommendations/v1",
    policyVersion: "recommendations/1",
    extractionId: input.extractionId,
    jdHash: input.jdHash,
    profileVersionId: input.profileVersionId,
    profileHash: input.profileHash,
    phrases,
    roles,
    themes,
    preset: {
      schemaVersion: "tailoring-focus/v1",
      selectedPhraseIds,
      themeId: presetThemeId,
      summaryDirection: defaultSummary,
      mappings,
      additionalGuidance: "",
    },
  });
}
