import { createHash } from "node:crypto";
import type { Arrangement } from "../domain/enums";
import {
  canonicalizeUrl,
  MAX_URL_LENGTH,
  sanitizeDestinationUrl,
} from "../scraping/urls";

/**
 * Field normalization ported from `services/discovery/normalizer.py` with
 * deliberate truthfulness fixes (same pattern as the R2-A URL port):
 *
 * - `generate_content_hash` is byte-exact, including code-point slicing
 *   of astral characters (Python `str` semantics, not UTF-16 units).
 * - Arrangement classification matches the legacy remote/hybrid/onsite/
 *   unknown mapping exactly; only the input shape changed (nullable
 *   location text plus a telecommute flag instead of a JobSpy boolean).
 * - Location/title cleaning is trim-only. The legacy "Toronto, ON,
 *   Canada" / "Remote Canada" / "Canada" expansions, the "Unknown Role"
 *   default, and the product-manager seniority inference are NOT ported:
 *   unknown values stay null and surface via `missingFields`.
 */

export function generateContentHash(
  company: string,
  title: string,
  description: string,
): string {
  const cleanDesc = Array.from(
    description.replace(/\s+/g, " ").trim().toLowerCase(),
  )
    .slice(0, 500)
    .join("");
  const payload =
    `${company.trim().toLowerCase()}|${title.trim().toLowerCase()}|${cleanDesc}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Trimmed text or null when empty; never a placeholder. */
export function cleanText(value: unknown, maxChars = 100_000): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

export function classifyArrangement(
  location: string | null,
  telecommute: boolean,
): Arrangement {
  const text = location ?? "";
  if (telecommute || /remote/i.test(text)) {
    return "REMOTE";
  }
  if (/hybrid/i.test(text)) {
    return "HYBRID";
  }
  if (cleanText(location) !== null) {
    return "ONSITE";
  }
  return "UNKNOWN";
}

export interface ParsedSalary {
  /** The source line, trimmed; always preserved even when unparseable. */
  text: string;
  currency: string | null;
  minMinor: number | null;
  maxMinor: number | null;
}

const HOURLY_MARKERS =
  /per\s+hour|\/\s*hr\b|hourly|\bp\.?\s?h\.?\b|per\s+day|daily\s+rate|per\s+month/i;

const MONEY_TOKEN_SOURCE =
  String.raw`(US\$|CA\$|A\$|US|CAD|AUD|GBP|EUR|£|€|\$)\s*([\d,]+(?:\.\d{1,2})?)\s*([kK])?`;

/**
 * Fresh money-token matcher per call. A shared `/g` regex carries
 * `lastIndex` state between `test` and `matchAll` callers, which made
 * find-then-parse sequences silently miss (regression-covered by the
 * adapter and generic fixture tests).
 */
function moneyTokens(text: string): RegExpMatchArray[] {
  return [...text.matchAll(new RegExp(MONEY_TOKEN_SOURCE, "g"))];
}

const CURRENCY_BY_MARKER: Readonly<Record<string, string>> = {
  $: "USD",
  "US$": "USD",
  US: "USD",
  "CA$": "CAD",
  CAD: "CAD",
  "A$": "AUD",
  AUD: "AUD",
  "£": "GBP",
  GBP: "GBP",
  "€": "EUR",
  EUR: "EUR",
};

function tokenToMinor(amount: string, kilo: string | undefined): number | null {
  const dollars = Number.parseFloat(amount.replace(/,/g, "")) * (kilo ? 1000 : 1);
  if (!Number.isFinite(dollars) || dollars < 0) {
    return null;
  }
  const minor = Math.round(dollars * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * Conservative annual-salary parsing. Minors are set only for explicit
 * annual-style amounts with a recognized currency; hourly/daily/monthly
 * rates and unrecognized currencies keep the raw text with null minors —
 * annualizing a rate would invent a number the posting never stated.
 */
export function parseSalaryLine(line: string): ParsedSalary | null {
  const text = line.trim();
  if (text === "") {
    return null;
  }
  const tokens: Array<{ currency: string | null; minor: number | null }> = [];
  for (const match of moneyTokens(text)) {
    // The alternation matches exact marker spellings, so match[1] is
    // always a known key; the fallback is defensive only.
    tokens.push({
      currency: CURRENCY_BY_MARKER[match[1]] ?? null,
      minor: tokenToMinor(match[2], match[3]),
    });
  }
  if (tokens.length === 0) {
    return null;
  }
  // An explicit currency code on the line ("$140k CAD") beats the bare
  // `$` default; first marker wins when no code is present.
  const codeMatch = /\b(USD|CAD|AUD|GBP|EUR)\b/i.exec(text);
  const currency = codeMatch !== null ? codeMatch[1].toUpperCase() : tokens[0].currency;
  if (HOURLY_MARKERS.test(text) || currency === null) {
    return { text: text.slice(0, 500), currency, minMinor: null, maxMinor: null };
  }
  const amounts = tokens
    .map((token) => token.minor)
    .filter((minor): minor is number => minor !== null);
  if (amounts.length === 0) {
    return { text: text.slice(0, 500), currency, minMinor: null, maxMinor: null };
  }
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  return { text: text.slice(0, 500), currency, minMinor: min, maxMinor: max };
}

/** First line carrying a money token, or null when the text has none. */
export function findSalaryLine(text: string): string | null {
  for (const line of text.split("\n")) {
    if (moneyTokens(line).length > 0) {
      return line.trim().slice(0, 500);
    }
  }
  return null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Posted-date normalization: ISO calendar dates pass through, other
 * parseable values become UTC ISO datetimes, and everything else is
 * null (the raw value survives inside `extracted_json`).
 */
export function parsePostedDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 100) {
    return null;
  }
  const iso = ISO_DATE.exec(trimmed);
  if (iso !== null) {
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return trimmed;
    }
    return null;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

/**
 * Resolve a possibly-relative apply href against the posting URL and
 * validate it through the URL policy. Preserves exact path structure
 * (including trailing slashes required by host routing), strips tracking
 * query params, and handles in-page anchors by returning finalUrl.
 * Returns null for empty, non-http(s), over-long, or otherwise rejected targets.
 */
export function resolveApplyUrl(
  href: string | null,
  finalUrl: string,
): string | null {
  if (href === null || typeof href !== "string") {
    return null;
  }
  const trimmedHref = href.trim();
  if (trimmedHref === "") {
    return null;
  }
  if (
    trimmedHref.toLowerCase().startsWith("javascript:") ||
    trimmedHref.toLowerCase().startsWith("mailto:") ||
    trimmedHref.toLowerCase().startsWith("tel:")
  ) {
    return null;
  }

  let finalParsed: URL;
  try {
    finalParsed = new URL(finalUrl.trim());
  } catch {
    return null;
  }
  if (finalParsed.protocol !== "http:" && finalParsed.protocol !== "https:") {
    return null;
  }

  // If href is an in-page fragment (e.g. #app, #apply, #), the application
  // form is embedded on the posting page itself. Return the verified finalUrl.
  if (trimmedHref.startsWith("#")) {
    return finalUrl;
  }

  let target: URL;
  try {
    target = new URL(trimmedHref, finalUrl);
  } catch {
    return null;
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return null;
  }
  if (target.username !== "" || target.password !== "") {
    return null;
  }

  const validation = canonicalizeUrl(target.toString());
  if (!validation.ok) {
    return null;
  }

  // If the target resolves to the same page as finalUrl, return finalUrl
  // to guarantee that the known-good posting URL path and query are preserved.
  if (
    target.origin === finalParsed.origin &&
    target.pathname.replace(/\/+$/, "") ===
      finalParsed.pathname.replace(/\/+$/, "") &&
    (target.search === "" || target.search === finalParsed.search)
  ) {
    return finalUrl;
  }

  const destination = sanitizeDestinationUrl(target);
  if (destination.length > MAX_URL_LENGTH) {
    return null;
  }
  return destination;
}
