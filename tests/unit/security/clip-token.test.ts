// @vitest-environment node
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getClipToken, verifyClipToken } from "../../../src/security/clip-token";

describe("clip token", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "job-tracker-clip-token-"));
    dirs.push(dir);
    return dir;
  }

  it("generates a stable 64-hex token stored owner-only", () => {
    const root = freshRoot();
    const first = getClipToken(root);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(getClipToken(root)).toBe(first);
    const mode = statSync(join(root, ".clip-token")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("verifies bearer headers in constant time shape", () => {
    const root = freshRoot();
    const token = getClipToken(root);
    expect(verifyClipToken(root, `Bearer ${token}`)).toBe(true);
    expect(verifyClipToken(root, null)).toBe(false);
    expect(verifyClipToken(root, "")).toBe(false);
    expect(verifyClipToken(root, `Token ${token}`)).toBe(false);
    expect(verifyClipToken(root, "Bearer short")).toBe(false);
    expect(verifyClipToken(root, `Bearer ${"0".repeat(64)}`)).toBe(false);
    expect(verifyClipToken(root, `Bearer ${token.toUpperCase()}`)).toBe(false);
  });

  it("fails closed on corrupt token files", () => {
    const root = freshRoot();
    writeFileSync(join(root, ".clip-token"), "not-a-token\n");
    expect(() => getClipToken(root)).toThrow(/corrupt/);
  });
});
