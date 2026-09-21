import { compareCodePoints, hasWordBoundary, normalizeTerm } from "./text";

/**
 * Pre-generation keyword support (WO-1.2-E, E4/E5). Pure deterministic
 * matching of JD suggestion phrases against a profile's APPROVED facts
 * (the caller filters verification state): no provider calls, no
 * stemming, no synonyms.
 *
 * Documented rule: the normalized phrase splits into significant terms
 * (stopwords dropped); each term must appear with word boundaries in
 * normalized fact text (statement plus raw evidence JSON — punctuation
 * is normalized away, so "CI/CD" matches "ci cd pipelines").
 *
 * - supported: every significant term co-occurs in ONE fact blob.
 * - uncertain: terms scatter across facts, or only some terms match
 *   (multi-term phrases only — single terms are binary).
 * - gap: no significant term matches any approved fact.
 *
 * `factIds` names every contributing fact (code-point order) so the UI
 * can cite evidence; it never invents support.
 */

export const KEYWORD_SUPPORT_POLICY_VERSION = "keyword-support/v1";

export type KeywordSupportStatus = "supported" | "uncertain" | "gap";

export interface SupportEvidence {
  factId: string;
  statement: string;
  evidenceJson: string | null;
}

export interface KeywordSupport {
  keyword: string;
  status: KeywordSupportStatus;
  factIds: string[];
}

const SUPPORT_STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "for",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

function significantTerms(keyword: string): string[] {
  return normalizeTerm(keyword)
    .split(" ")
    .filter((term) => term !== "" && !SUPPORT_STOPWORDS.has(term));
}

function evidenceBlob(evidence: SupportEvidence): string {
  return normalizeTerm(`${evidence.statement} ${evidence.evidenceJson ?? ""}`);
}

export function evaluateKeywordSupport(
  keywords: string[],
  evidence: SupportEvidence[],
): KeywordSupport[] {
  const blobs = evidence.map((entry) => ({
    factId: entry.factId,
    text: evidenceBlob(entry),
  }));
  return keywords.map((keyword) => {
    const terms = significantTerms(keyword);
    const matchedByTerm = terms.map((term) =>
      blobs.filter((blob) => hasWordBoundary(term, blob.text)).map((blob) => blob.factId),
    );
    const contributing = [...new Set(matchedByTerm.flat())].sort(compareCodePoints);
    if (terms.length === 0 || matchedByTerm.every((factIds) => factIds.length === 0)) {
      return { keyword, status: "gap", factIds: [] };
    }
    const together = blobs.some((blob) =>
      terms.every((term) => hasWordBoundary(term, blob.text)),
    );
    if (together || terms.length === 1) {
      // A matched single term is trivially "together"; multi-term
      // phrases need one fact backing the whole phrase.
      return { keyword, status: "supported", factIds: contributing };
    }
    return { keyword, status: "uncertain", factIds: contributing };
  });
}
