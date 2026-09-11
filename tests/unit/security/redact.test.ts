// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  redactEmail,
  redactPhone,
  redactSecrets,
} from "../../../src/security";

describe("log redaction", () => {
  it("redacts secret-keyed values without mutating input", () => {
    const input = {
      jobId: "j1",
      apiKey: "sk-live",
      nested: { password: "hunter2", deep: [{ token: "t" }] },
      Authorization: "Bearer x",
      cookie: "session=abc",
    };
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(out.jobId).toBe("j1");
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.Authorization).toBe("[REDACTED]");
    expect(out.cookie).toBe("[REDACTED]");
    const nested = out.nested as Record<string, unknown>;
    expect(nested.password).toBe("[REDACTED]");
    expect(nested.deep).toEqual([{ token: "[REDACTED]" }]);
    // Input untouched.
    expect(input.apiKey).toBe("sk-live");
    expect((input.nested.deep[0] as Record<string, string>).token).toBe("t");
  });

  it("handles circular structures, depth, and errors safely", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const out = redactSecrets(circular) as Record<string, unknown>;
    expect(out.a).toBe(1);
    expect(out.self).toBe("[Circular]");

    let deep: unknown = { leaf: "x" };
    for (let i = 0; i < 30; i += 1) {
      deep = { next: deep };
    }
    expect(JSON.stringify(redactSecrets(deep))).toContain("[REDACTED]");

    expect(redactSecrets(new Error("boom"))).toEqual({
      name: "Error",
      message: "boom",
    });
    expect(redactSecrets("plain")).toBe("plain");
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBeNull();
  });

  it("masks email and phone identifiers explicitly", () => {
    expect(redactEmail("ada@example.com")).toBe("***@example.com");
    expect(redactEmail("not-an-email")).toBe("[REDACTED]");
    expect(redactPhone("+1 (555) 123-4567")).toBe("***4567");
    expect(redactPhone("12")).toBe("[REDACTED]");
  });
});
