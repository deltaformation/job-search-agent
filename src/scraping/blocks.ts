import type { ReasonCode } from "../domain/enums";

/**
 * Blocked-page detection. The fetcher gathers cheap signals (HTTP status
 * plus bounded page-text/HTML samples) and this pure classifier rules on
 * them. Deliberately conservative: anything uncertain stays a fetch
 * success and lets R2-D extraction report incompleteness, because a
 * false block hides a real posting while a false success stays visible.
 *
 * Tested directly on strings; the browser tests replay the same signals
 * through real pages.
 */

export type BlockReason = "LOGIN_REQUIRED" | "CAPTCHA_REQUIRED" | "ACCESS_DENIED";

export interface BlockSignals {
  httpStatus: number | null;
  /** Lowercased visible-text sample (bounded by the fetcher). */
  textSample: string;
  /** Lowercased raw-HTML sample (bounded by the fetcher). */
  htmlSample: string;
  /** Lowercased document title. */
  title: string;
}

export type BlockVerdict =
  | { blocked: true; reasonCode: BlockReason; detail: string }
  | { blocked: false };

const CAPTCHA_MARKERS = [
  "recaptcha",
  "g-recaptcha",
  "hcaptcha",
  "h-captcha",
  "turnstile",
  "cf-chl",
  "captcha",
];

const LOGIN_MARKERS = [
  'type="password"',
  "type='password'",
  'name="password"',
  'autocomplete="current-password"',
];

const LOGIN_PHRASES = ["sign in to continue", "log in to continue", "login to continue"];

const DENIED_PHRASES = [
  "access denied",
  "access to this page has been denied",
  "forbidden",
  "request blocked",
];

function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/**
 * Rule on one fetched page. Status-driven denials win first (authoritative),
 * then CAPTCHA markers (a challenge blocks extraction either way), then
 * login markers, which additionally require a login phrase so a stray
 * password field (a newsletter signup) does not block a real posting.
 */
export function detectBlock(signals: BlockSignals): BlockVerdict {
  const { httpStatus } = signals;
  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    httpStatus === 407 ||
    httpStatus === 451
  ) {
    return {
      blocked: true,
      reasonCode: "ACCESS_DENIED",
      detail: `server refused the page (HTTP ${httpStatus})`,
    };
  }
  const html = signals.htmlSample.toLowerCase();
  const text = signals.textSample.toLowerCase();
  const title = signals.title.toLowerCase();
  if (containsAny(html, CAPTCHA_MARKERS) || text.includes("captcha")) {
    return {
      blocked: true,
      reasonCode: "CAPTCHA_REQUIRED",
      detail: "page presents a human-verification challenge",
    };
  }
  if (
    containsAny(html, LOGIN_MARKERS) &&
    (containsAny(text, LOGIN_PHRASES) || containsAny(title, LOGIN_PHRASES))
  ) {
    return {
      blocked: true,
      reasonCode: "LOGIN_REQUIRED",
      detail: "page requires signing in before showing the posting",
    };
  }
  if (
    containsAny(text, DENIED_PHRASES) ||
    (title.includes("denied") && text.length < 2000)
  ) {
    return {
      blocked: true,
      reasonCode: "ACCESS_DENIED",
      detail: "page text reports access denied",
    };
  }
  return { blocked: false };
}

/** Block reasons are a subset of the shared reason-code vocabulary. */
export const BLOCK_REASONS: ReadonlyArray<ReasonCode> = [
  "LOGIN_REQUIRED",
  "CAPTCHA_REQUIRED",
  "ACCESS_DENIED",
];
