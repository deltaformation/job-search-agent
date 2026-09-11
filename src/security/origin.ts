/**
 * Loopback Host/Origin policy. Localhost is not a trust boundary: the Host
 * check blocks DNS rebinding (evil.com resolving to 127.0.0.1) and the
 * Origin check blocks cross-site mutation attempts, since ambient
 * localhost reachability is the only authority a forged request needs.
 *
 * Matching is exact (hostname case-insensitive, port exact). There is no
 * suffix matching, so `127.0.0.1.evil.com` never matches `127.0.0.1`.
 */

export const LOOPBACK_HOSTNAMES: ReadonlyArray<string> = [
  "127.0.0.1",
  "localhost",
];

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.includes(hostname.trim().toLowerCase());
}

export function defaultLocalHosts(port: number): ReadonlyArray<string> {
  return LOOPBACK_HOSTNAMES.map((host) => `${host}:${port}`);
}

export function defaultLocalOrigins(port: number): ReadonlyArray<string> {
  return LOOPBACK_HOSTNAMES.map((host) => `http://${host}:${port}`);
}

interface ParsedHost {
  hostname: string;
  port: string | null;
}

/** Parse a Host header value without ever throwing. */
export function parseHostHeader(value: string | null): ParsedHost | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    trimmed.includes("@") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes(" ") ||
    trimmed.includes("[") ||
    trimmed.includes("]") ||
    trimmed.includes("#") ||
    trimmed.includes("?")
  ) {
    return null;
  }
  const clean = trimmed.toLowerCase();
  const colon = clean.lastIndexOf(":");
  if (colon === -1) {
    return { hostname: clean, port: null };
  }
  const hostname = clean.slice(0, colon);
  const port = clean.slice(colon + 1);
  if (hostname === "" || port === "" || !/^[0-9]+$/.test(port)) {
    return null;
  }
  return { hostname, port };
}

/** Exact-match a Host header against `hostname:port` allowlist entries. */
export function verifyHostHeader(
  value: string | null,
  allowedHosts: readonly string[],
): boolean {
  const parsed = parseHostHeader(value);
  if (parsed === null || parsed.port === null) {
    return false;
  }
  return allowedHosts.includes(`${parsed.hostname}:${parsed.port}`);
}

export type OriginVerdict = "valid" | "missing" | "invalid";

/** Exact-match an Origin header against `http://host:port` entries. */
export function verifyOriginHeader(
  value: string | null,
  allowedOrigins: readonly string[],
): OriginVerdict {
  if (value === null || value.trim() === "") {
    return "missing";
  }
  return allowedOrigins.includes(value.trim()) ? "valid" : "invalid";
}

export interface MutationRequest {
  host: string | null;
  origin: string | null;
  /** `Sec-Fetch-Site` header when the client sends one. */
  secFetchSite?: string | null;
}

export type MutationCheck =
  | { ok: true }
  | { ok: false; reason: "bad-host" | "bad-origin" | "missing-origin" };

/**
 * Gate a state-changing request. Mutations require a valid Host plus either
 * a valid Origin or, when no Origin is sent, an explicit same-origin fetch
 * signal. Local scripts without browser fetch metadata must send
 * `Origin: http://127.0.0.1:<port>` explicitly.
 */
export function verifyMutationRequest(
  request: MutationRequest,
  policy: { allowedHosts: readonly string[]; allowedOrigins: readonly string[] },
): MutationCheck {
  if (!verifyHostHeader(request.host, policy.allowedHosts)) {
    return { ok: false, reason: "bad-host" };
  }
  const origin = verifyOriginHeader(request.origin, policy.allowedOrigins);
  if (origin === "valid") {
    return { ok: true };
  }
  if (origin === "invalid") {
    return { ok: false, reason: "bad-origin" };
  }
  if (
    request.secFetchSite !== null &&
    request.secFetchSite !== undefined &&
    request.secFetchSite.trim().toLowerCase() === "same-origin"
  ) {
    return { ok: true };
  }
  return { ok: false, reason: "missing-origin" };
}

/** Gate a read-only request: Host rebinding protection only. */
export function verifyReadRequest(
  host: string | null,
  policy: { allowedHosts: readonly string[] },
): boolean {
  return verifyHostHeader(host, policy.allowedHosts);
}
