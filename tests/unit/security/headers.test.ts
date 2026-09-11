// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SECURITY_HEADERS, securityHeaderEntries } from "../../../src/security";

describe("response security headers", () => {
  it("sends framing, sniffing, referrer, and capability guards", () => {
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");
    expect(SECURITY_HEADERS["Referrer-Policy"]).toBe("no-referrer");
    expect(SECURITY_HEADERS["Permissions-Policy"]).toContain("camera=()");
  });

  it("keeps CSP in report-only mode until nonces land", () => {
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toBeUndefined();
    expect(SECURITY_HEADERS["Content-Security-Policy-Report-Only"]).toContain(
      "default-src 'self'",
    );
  });

  it("exposes stable entries for middleware", () => {
    const entries = securityHeaderEntries();
    expect(entries.length).toBeGreaterThan(0);
    expect(new Map(entries)).toEqual(new Map(Object.entries(SECURITY_HEADERS)));
  });
});
