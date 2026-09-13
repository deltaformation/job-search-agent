import { isIP } from "node:net";

/**
 * URL intake policy: parse, validate, and canonicalize user-pasted job URLs.
 *
 * Cases ported from `services/discovery/normalizer.py::clean_url` (tracking
 * strip, host lowercasing, trailing-slash trim, fragment drop, Indeed `jk`
 * and LinkedIn job-ID recognition) with deliberate fixes: the legacy
 * case-insensitive match bug for `spJobID`/`spPostingID`, host-rewriting
 * Indeed/LinkedIn shortcuts (geo- and scheme-rewriting), substring ATS
 * matching, and unstable query order are not carried over. See below.
 */

export const MAX_URL_LENGTH = 2048;

/** Lowercase tracking parameter names stripped from the canonical form. */
export const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "ref",
  "source",
  "tracking",
  "trackingid",
  "trk",
  "fbclid",
  "gclid",
  "msclkid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "campaign",
  "spjobid",
  "sppostingid",
  "from",
]);

export interface CanonicalUrl {
  /** Trimmed user input, preserved verbatim for evidence and fetching. */
  submittedUrl: string;
  /** Normalized URL: tracking stripped, sorted query, no fragment. */
  canonicalUrl: string;
  /**
   * Dedupe key. `ats:<board>:<id>` when a stable posting identifier is
   * recognized, otherwise `url:<canonicalUrl>`. Namespaces cannot collide.
   */
  canonicalKey: string;
  /** Lowercase ASCII hostname (IPv6 without brackets for classification). */
  hostname: string;
  scheme: "http" | "https";
}

export interface InvalidUrl {
  ok: false;
  reason: "INVALID_URL";
  detail: string;
}

export type CanonicalizeResult =
  | { ok: true; value: CanonicalUrl }
  | InvalidUrl;

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function isValidDnsName(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) {
    return false;
  }
  return hostname.split(".").every((label) => DNS_LABEL.test(label));
}

export function sortedQuery(url: URL): string {
  const kept: Array<[string, string]> = [];
  url.searchParams.forEach((value, name) => {
    const lowered = name.toLowerCase();
    if (lowered.startsWith("utm_") || TRACKING_PARAMS.has(lowered)) {
      return;
    }
    kept.push([name, value]);
  });
  kept.sort(([nameA, valueA], [nameB, valueB]) =>
    nameA < nameB ? -1 : nameA > nameB ? 1 : valueA < valueB ? -1 : valueA > valueB ? 1 : 0,
  );
  return new URLSearchParams(kept).toString();
}

/**
 * Construct an actionable destination URL: preserves the verbatim pathname
 * (including any trailing slash required by host routing), strips tracking
 * parameters from the query string, drops hash fragments, and normalizes
 * the host/port.
 */
export function sanitizeDestinationUrl(url: URL): string {
  const port = url.port;
  const path = url.pathname === "" ? "/" : url.pathname;
  const query = sortedQuery(url);
  let hostname = url.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (hostname.endsWith(".") && hostname.length > 1) {
    hostname = hostname.slice(0, -1);
  }
  const ipVersion = isIP(hostname);
  const host = ipVersion === 6 ? `[${hostname}]` : hostname;
  return `${url.protocol}//${host}${port === "" ? "" : `:${port}`}${path}${query === "" ? "" : `?${query}`}`;
}

/** Exact-or-subdomain host match (legacy used substring matching). */
function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function indeedKey(hostname: string, url: URL): string | null {
  const labels = hostname.split(".");
  const isIndeed =
    labels.length >= 2 &&
    labels[labels.length - 2] === "indeed" &&
    /^[a-z]{2,}$/.test(labels[labels.length - 1]);
  if (!isIndeed) {
    return null;
  }
  const jk = url.searchParams.get("jk");
  if (jk === null || jk === "") {
    return null;
  }
  return `ats:indeed:${jk}`;
}

function linkedInKey(hostname: string, url: URL): string | null {
  if (!hostMatches(hostname, "linkedin.com")) {
    return null;
  }
  const pathMatch = /\/jobs\/view\/(\d+)/.exec(url.pathname);
  if (pathMatch !== null) {
    return `ats:linkedin:${pathMatch[1]}`;
  }
  const currentJobId = url.searchParams.get("currentJobId");
  if (currentJobId !== null && /^\d+$/.test(currentJobId)) {
    return `ats:linkedin:${currentJobId}`;
  }
  return null;
}

/**
 * Validate one pasted line and derive its canonical forms. Pure and
 * synchronous: DNS/SSRF preflight happens separately in `ssrf.ts`.
 */
export function canonicalizeUrl(raw: string): CanonicalizeResult {
  const submittedUrl = raw.trim();
  if (submittedUrl === "") {
    return { ok: false, reason: "INVALID_URL", detail: "empty URL" };
  }
  if (submittedUrl.length > MAX_URL_LENGTH) {
    return {
      ok: false,
      reason: "INVALID_URL",
      detail: `URL exceeds ${MAX_URL_LENGTH} characters`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(submittedUrl);
  } catch {
    return {
      ok: false,
      reason: "INVALID_URL",
      detail: "not a parseable absolute URL",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: "INVALID_URL",
      detail: "only http and https URLs are accepted",
    };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return {
      ok: false,
      reason: "INVALID_URL",
      detail: "URLs with embedded credentials are rejected",
    };
  }

  let hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (hostname.endsWith(".") && hostname.length > 1) {
    hostname = hostname.slice(0, -1);
  }
  const ipVersion = isIP(hostname);
  if (ipVersion === 0 && !isValidDnsName(hostname)) {
    return {
      ok: false,
      reason: "INVALID_URL",
      detail: "invalid hostname",
    };
  }

  const port = parsed.port;
  const rawPath = parsed.pathname;
  const path =
    rawPath === "" || rawPath === "/" ? "" : rawPath.replace(/\/+$/, "");
  const query = sortedQuery(parsed);
  const host = ipVersion === 6 ? `[${hostname}]` : hostname;
  const canonicalUrl = `${parsed.protocol}//${host}${port === "" ? "" : `:${port}`}${path}${query === "" ? "" : `?${query}`}`;

  const indeed = indeedKey(hostname, parsed);
  if (indeed !== null) {
    return {
      ok: true,
      value: {
        submittedUrl,
        canonicalUrl,
        canonicalKey: indeed,
        hostname,
        scheme: parsed.protocol === "https:" ? "https" : "http",
      },
    };
  }
  const linkedIn = linkedInKey(hostname, parsed);
  return {
    ok: true,
    value: {
      submittedUrl,
      canonicalUrl,
      canonicalKey: linkedIn ?? `url:${canonicalUrl}`,
      hostname,
      scheme: parsed.protocol === "https:" ? "https" : "http",
    },
  };
}

/** Known ATS domains, ported from `deduplicator.py` (exact list). */
export const KNOWN_ATS_DOMAINS: ReadonlyArray<string> = [
  "lever.co",
  "greenhouse.io",
  "workday.com",
  "ashbyhq.com",
  "smartrecruiters.com",
  "icims.com",
  "taleo.net",
  "bamboohr.com",
  "rippling-ats.com",
  "myworkdayjobs.com",
];

/** True when the hostname is an ATS domain or its subdomain. */
export function isAtsUrl(canonical: CanonicalUrl): boolean {
  return KNOWN_ATS_DOMAINS.some((domain) =>
    hostMatches(canonical.hostname, domain),
  );
}

/**
 * Legacy-compatible ATS label: capitalized first DNS label of the matched
 * domain (`greenhouse.io` → `Greenhouse`). R2-D maps labels to adapters.
 */
export function detectAtsType(canonical: CanonicalUrl): string | null {
  for (const domain of KNOWN_ATS_DOMAINS) {
    if (hostMatches(canonical.hostname, domain)) {
      const first = domain.split(".")[0];
      return first.charAt(0).toUpperCase() + first.slice(1);
    }
  }
  return null;
}
