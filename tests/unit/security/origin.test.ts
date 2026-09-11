// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  defaultLocalHosts,
  defaultLocalOrigins,
  isLoopbackHostname,
  parseHostHeader,
  verifyHostHeader,
  verifyMutationRequest,
  verifyOriginHeader,
  verifyReadRequest,
} from "../../../src/security";

const POLICY = {
  allowedHosts: defaultLocalHosts(3000),
  allowedOrigins: defaultLocalOrigins(3000),
};

describe("loopback Host/Origin policy", () => {
  it("recognizes loopback hostnames only", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("LOCALHOST")).toBe(true);
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
    expect(isLoopbackHostname("example.com")).toBe(false);
    expect(isLoopbackHostname("127.0.0.1.evil.com")).toBe(false);
  });

  it("parses Host headers without throwing", () => {
    expect(parseHostHeader("127.0.0.1:3000")).toEqual({
      hostname: "127.0.0.1",
      port: "3000",
    });
    expect(parseHostHeader("LOCALHOST:3000")).toEqual({
      hostname: "localhost",
      port: "3000",
    });
    // Portless Host is protocol-valid syntax; policy still rejects it below.
    expect(parseHostHeader("127.0.0.1")).toEqual({
      hostname: "127.0.0.1",
      port: null,
    });
    for (const bad of [
      null,
      "",
      "   ",
      "127.0.0.1:",
      ":3000",
      "127.0.0.1:http",
      "user@127.0.0.1:3000",
      "127.0.0.1:3000/path",
      "127.0.0.1:3000 3001",
      "[::1]:3000",
    ]) {
      expect(parseHostHeader(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("exact-matches Host headers against the allowlist", () => {
    expect(verifyHostHeader("127.0.0.1:3000", POLICY.allowedHosts)).toBe(true);
    expect(verifyHostHeader("localhost:3000", POLICY.allowedHosts)).toBe(true);
    for (const bad of [
      "127.0.0.1:3001",
      "127.0.0.1",
      "127.0.0.1.evil.com:3000",
      "evil127.0.0.1.com:3000",
      "evil.com:3000",
      "127.0.0.1:3000#x",
      "127.0.0.1:3000?x",
      null,
    ]) {
      expect(verifyHostHeader(bad, POLICY.allowedHosts), String(bad)).toBe(false);
    }
  });

  it("exact-matches Origin headers", () => {
    expect(
      verifyOriginHeader("http://127.0.0.1:3000", POLICY.allowedOrigins),
    ).toBe("valid");
    expect(verifyOriginHeader(null, POLICY.allowedOrigins)).toBe("missing");
    expect(verifyOriginHeader("  ", POLICY.allowedOrigins)).toBe("missing");
    for (const bad of [
      "http://127.0.0.1:3001",
      "https://127.0.0.1:3000",
      "http://evil.com",
      "http://127.0.0.1.evil.com:3000",
      "null",
    ]) {
      expect(verifyOriginHeader(bad, POLICY.allowedOrigins), bad).toBe("invalid");
    }
  });

  it("gates mutations on Host plus Origin or same-origin fetch proof", () => {
    expect(
      verifyMutationRequest(
        { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
        POLICY,
      ),
    ).toEqual({ ok: true });
    // Browser same-origin fetch without an Origin header still passes.
    expect(
      verifyMutationRequest(
        { host: "localhost:3000", origin: null, secFetchSite: "same-origin" },
        POLICY,
      ),
    ).toEqual({ ok: true });
    // Cross-site forgery and rebinding fail closed.
    expect(
      verifyMutationRequest(
        { host: "evil.com:3000", origin: "http://evil.com:3000" },
        POLICY,
      ),
    ).toEqual({ ok: false, reason: "bad-host" });
    expect(
      verifyMutationRequest(
        { host: "127.0.0.1:3000", origin: "http://evil.com:3000" },
        POLICY,
      ),
    ).toEqual({ ok: false, reason: "bad-origin" });
    // Headerless clients (curl without -H) are rejected, not trusted.
    expect(
      verifyMutationRequest({ host: "127.0.0.1:3000", origin: null }, POLICY),
    ).toEqual({ ok: false, reason: "missing-origin" });
    expect(
      verifyMutationRequest(
        { host: "127.0.0.1:3000", origin: null, secFetchSite: "cross-site" },
        POLICY,
      ),
    ).toEqual({ ok: false, reason: "missing-origin" });
  });

  it("gates reads on Host only", () => {
    expect(verifyReadRequest("127.0.0.1:3000", POLICY)).toBe(true);
    expect(verifyReadRequest("evil.com:3000", POLICY)).toBe(false);
    expect(verifyReadRequest(null, POLICY)).toBe(false);
  });
});
