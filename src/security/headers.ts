/**
 * Response security headers applied to every product route by middleware.
 * The set is deliberately breakage-free under Next.js: enforcing CSP is
 * deferred until the UI stabilizes (Next needs nonces for inline runtime
 * scripts), so R1 ships CSP in report-only mode as a tripwire while the
 * framing, sniffing, referrer, and capability headers already enforce.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Content-Security-Policy-Report-Only": "default-src 'self'",
};

export function securityHeaderEntries(): Array<[string, string]> {
  return Object.entries(SECURITY_HEADERS);
}
