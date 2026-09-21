/**
 * Human-directive guard (WO-1.2-D, D6).
 *
 * Directives shape ranking and wording, but they can never smuggle
 * numbers onto the resume: any KPI-shaped token in a directive line
 * (percentages, currency, scaled magnitudes, team counts) must already
 * appear in an approved candidate fact, otherwise the line records an
 * explicit `unsupported` gap and the deterministic draft — built only
 * from approved facts — omits the number by construction.
 *
 * Pure module: no database, provider, or framework imports.
 */

export interface DirectiveOutcome {
  /** Zero-based index of the non-empty directive line. */
  index: number;
  /** The directive line, truncated for storage. */
  directive: string;
  /** Normalized KPI tokens found in the line, in order, deduplicated. */
  kpiTokens: string[];
  /** Tokens with no approved-fact backing. Empty means supported. */
  unbackedTokens: string[];
  status: "supported" | "unsupported";
  /** Set exactly when unsupported: names the unbacked tokens. */
  explanation: string | null;
}

const CURRENCY_TOKEN = /\$\s*\d[\d,]*(?:\.\d+)?\s*(?:million|billion|thousand|[mkb])?/gi;
// `%` carries no trailing word boundary (it is a non-word char); the
// word-form scales keep theirs. The lookbehind rejects fragments of a
// longer number ("2M" inside "1.2M").
const SCALED_TOKEN =
  /(?:(?<![\d,.])\b\d[\d,]*(?:\.\d+)?\s*(?:percent|million|billion|thousand|[mkb]|x)\b|(?<![\d,.])\b\d[\d,]*(?:\.\d+)?\s*%)/gi;
// The lookbehind rejects fragments of a grouped number ("000" inside
// "2,000"), which would otherwise read as phantom KPI tokens.
const PLUS_TOKEN = /(?<![\d,])\b\d[\d,]*\+/g;
// Bare counts of 3+ digits ("managed 200 engineers") with 4-digit
// calendar years excluded so dates never read as KPIs.
const COUNT_TOKEN = /(?<![\d,])\b(?!19\d\d\b|20\d\d\b|2100\b)\d{3,}[\d,]*/g;

function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[$,\s+]/g, "");
}

/**
 * Approved-fact backing index. Each fact contributes its standalone
 * chunks plus every adjacent pair-join, all normalized exactly like
 * KPI tokens. Membership (not substring) decides backing, so "200"
 * never matches inside "2,000" — while "20 percent" still backs via
 * the "20"+"percent" pair (every multi-word token the patterns emit
 * spans at most one space, so pair-joins cover them all).
 */
function corpusTokenSet(text: string): Set<string> {
  const chunks = text
    .toLowerCase()
    .split(/[^a-z0-9$.,+%-]+/)
    .map((chunk) => chunk.replace(/[$,\s+]/g, "").replace(/^\.+|\.+$/g, ""))
    .filter((chunk) => chunk !== "");
  const tokens = new Set(chunks);
  for (let index = 0; index + 1 < chunks.length; index += 1) {
    tokens.add(`${chunks[index]}${chunks[index + 1]}`);
  }
  return tokens;
}

/**
 * Extract normalized KPI-shaped tokens from free text, in order of
 * first appearance, deduplicated. Empty when the text states no
 * measurable claim.
 */
export function extractKpiTokens(text: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  const patterns = [CURRENCY_TOKEN, SCALED_TOKEN, PLUS_TOKEN, COUNT_TOKEN];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const token = normalizeToken(match[0]);
      if (token !== "" && !seen.has(token)) {
        seen.add(token);
        tokens.push(token);
      }
    }
  }
  return tokens;
}

/**
 * Non-empty directive lines in gap-index order: persisted unsupported
 * lines become `directive-{index}` gaps, so review-time coaching must
 * split stored directives with this exact rule (WO-1.2-E).
 */
export function splitDirectiveLines(directives: string): string[] {
  return directives
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Evaluate each non-empty directive line against the approved-fact
 * backing corpus (one entry per approved fact: statement, metrics,
 * and technologies joined). A line with no KPI tokens is supported —
 * it carries no measurable claim to verify. A line is unsupported
 * when any of its tokens appears in no approved fact.
 */
export function evaluateDirectiveOutcomes(
  directives: string | undefined,
  approvedFactTexts: string[],
): DirectiveOutcome[] {
  if (directives === undefined) {
    return [];
  }
  const corpus = new Set<string>();
  for (const text of approvedFactTexts) {
    for (const token of corpusTokenSet(text)) {
      corpus.add(token);
    }
  }
  const outcomes: DirectiveOutcome[] = [];
  const lines = splitDirectiveLines(directives);
  for (const [index, line] of lines.entries()) {
    const kpiTokens = extractKpiTokens(line);
    const unbackedTokens = kpiTokens.filter((token) => !corpus.has(token));
    const status = unbackedTokens.length === 0 ? "supported" : "unsupported";
    outcomes.push({
      index,
      directive: line.slice(0, 280),
      kpiTokens,
      unbackedTokens,
      status,
      explanation:
        status === "supported"
          ? null
          : `KPI ${unbackedTokens.length === 1 ? "token" : "tokens"} ` +
            `${unbackedTokens.map((token) => `"${token}"`).join(", ")} ` +
            `is not backed by any approved fact; the tailored resume omits ` +
            `this claim and records it as an unsupported gap.`,
    });
  }
  return outcomes;
}
