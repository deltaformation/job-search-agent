import type { ReasonCode } from "../domain/enums";
import { canonicalizeUrl } from "./urls";

/**
 * Per-request network guard for the R2-C fetcher. Every navigation,
 * redirect hop, subresource, popup, and download request passes through
 * here before Playwright touches the network; anything that fails
 * closed aborts the request with a reason-coded verdict.
 *
 * Pure classification lives in `classifyRequestUrl` (unit-tested without
 * a browser). DNS revalidation is async and lives with the route wiring
 * in `fetch.ts`, which calls `preflightHost` per request so redirects
 * and rebinding cannot slip past the intake-time check.
 */

export const MAX_REDIRECTS = 5;

export type GuardVerdict =
  | { allow: true }
  | { allow: false; reasonCode: ReasonCode; detail: string };

/**
 * Synchronous policy over one request URL: public http(s), no embedded
 * credentials, valid hostname, within the redirect budget. Returns the
 * canonicalized URL on success so callers reuse the parsed hostname.
 */
export function classifyRequestUrl(
  rawUrl: string,
  redirectDepth: number,
): GuardVerdict & { hostname?: string } {
  if (!Number.isInteger(redirectDepth) || redirectDepth < 0) {
    return {
      allow: false,
      reasonCode: "INVALID_URL",
      detail: "negative redirect depth",
    };
  }
  if (redirectDepth > MAX_REDIRECTS) {
    return {
      allow: false,
      reasonCode: "INVALID_URL",
      detail: `redirect chain exceeds ${MAX_REDIRECTS} hops`,
    };
  }
  const canonical = canonicalizeUrl(rawUrl);
  if (!canonical.ok) {
    return {
      allow: false,
      reasonCode: "INVALID_URL",
      detail: canonical.detail,
    };
  }
  return { allow: true, hostname: canonical.value.hostname };
}

/**
 * Count the redirect hops behind one Playwright request by walking its
 * `redirectedFrom` chain. Iterative: chains are attacker-influenced and
 * must not recurse.
 */
export function countRedirects(request: {
  redirectedFrom(): { redirectedFrom(): unknown } | null;
}): number {
  let depth = 0;
  let current: { redirectedFrom(): unknown } | null =
    request.redirectedFrom();
  while (current !== null) {
    depth += 1;
    const next = current.redirectedFrom() as {
      redirectedFrom(): unknown;
    } | null;
    current = next;
    if (depth > MAX_REDIRECTS + 1) {
      break;
    }
  }
  return depth;
}
