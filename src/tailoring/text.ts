/**
 * Text matching primitives ported from the legacy oracle (`normalize_term`
 * in `services/documents/keywords.py`, also used by `summary.py`).
 *
 * Unicode notes (reviewed, not accidental):
 * - NFKC via `String.prototype.normalize`, identical to Python's.
 * - Python `casefold()` has no JS equivalent; `casefoldWord` applies
 *   `toLowerCase` plus the eszett special (ß/ẞ → ss). NFKC already expands
 *   Latin ligatures, so no other specials are needed. A mismatch here can
 *   only miss a keyword, never fabricate one.
 * - Python `\w` is Unicode-aware; the classes below use Unicode
 *   letter/number properties plus underscore to match it.
 * - String ordering uses code-point comparison (`compareCodePoints`),
 *   matching Python's code-point order for astral characters where JS
 *   default sort (UTF-16 units) would diverge.
 */
import { pyString, pyTruthy } from "./primitives";

/** Approximate Python `str.casefold` for resume/JD text (see module note). */
export function casefoldWord(value: string): string {
  return value.toLowerCase().replace(/ß/g, "ss");
}

/**
 * Oracle `normalize_term`: NFKC, casefold, hyphens/slashes to spaces,
 * non-word characters to spaces, collapse whitespace, trim. Never infers
 * synonyms; falsy input normalizes to "".
 */
export function normalizeTerm(value: unknown): string {
  const base = pyTruthy(value) ? pyString(value) : "";
  if (base === "") {
    return "";
  }
  const cleaned = base.normalize("NFKC");
  const folded = casefoldWord(cleaned);
  const spaced = folded.replace(/-/g, " ").replace(/\//g, " ");
  const words = spaced.replace(/[^\p{L}\p{N}_\s]/gu, " ");
  return words.replace(/\s+/g, " ").trim();
}

const WORD_CHAR = "[\\p{L}\\p{N}_]";

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Oracle `\b`-anchored skill match: `term` appears in `phrase` with no word
 * character adjacent on either side.
 */
export function hasWordBoundary(term: string, phrase: string): boolean {
  const pattern = new RegExp(
    `(?<!${WORD_CHAR})${escapeRegExp(term)}(?!${WORD_CHAR})`,
    "u",
  );
  return pattern.test(phrase);
}

/** Code-point string comparison (Python `sorted` semantics). */
export function compareCodePoints(left: string, right: string): number {
  const leftChars = Array.from(left);
  const rightChars = Array.from(right);
  const shared = Math.min(leftChars.length, rightChars.length);
  for (let index = 0; index < shared; index += 1) {
    const leftPoint = (leftChars[index] as string).codePointAt(0) as number;
    const rightPoint = (rightChars[index] as string).codePointAt(0) as number;
    if (leftPoint !== rightPoint) {
      return leftPoint < rightPoint ? -1 : 1;
    }
  }
  if (leftChars.length === rightChars.length) {
    return 0;
  }
  return leftChars.length < rightChars.length ? -1 : 1;
}
