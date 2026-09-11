// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPathWithinRoot,
  resolveArtifactPath,
  resolveWithinRoot,
} from "../../../src/security";

describe("data-root path policy", () => {
  it("detects containment on normalized paths", () => {
    expect(isPathWithinRoot("/data/root", "/data/root")).toBe(true);
    expect(isPathWithinRoot("/data/root", "/data/root/a/b")).toBe(true);
    expect(isPathWithinRoot("/data/root", "/data/other")).toBe(false);
    // Prefix tricks without a separator boundary do not count.
    expect(isPathWithinRoot("/data/root", "/data/root-evil")).toBe(false);
    expect(isPathWithinRoot("/data/root", "/data/root/../other")).toBe(false);
  });

  it("resolves safe relative paths beneath the root", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-tracker-paths-"));
    try {
      mkdirSync(join(dir, "evidence"), { recursive: true });
      const resolved = resolveWithinRoot(dir, "evidence/a.html");
      expect(resolved).toBe(join(dir, "evidence", "a.html"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects absolute paths, traversal, and ambiguous shapes", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-tracker-paths-"));
    try {
      for (const bad of [
        "/etc/passwd",
        "C:/Windows/x",
        "..",
        "../x",
        "a/../../x",
        "a//b",
        "./a",
        "a\\b",
        "",
      ]) {
        expect(() => resolveWithinRoot(dir, bad), JSON.stringify(bad)).toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses symlink escapes but tolerates symlinks above the root", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-tracker-paths-"));
    try {
      const real = join(dir, "real");
      mkdirSync(join(real, "evidence"), { recursive: true });
      writeFileSync(join(real, "evidence", "page.html"), "<html></html>");
      symlinkSync(join(real, "evidence"), join(dir, "linked"));

      // A symlinked segment inside the root is refused.
      expect(() => resolveArtifactPath(dir, "linked/page.html")).toThrow(
        /symlink/,
      );
      // Plain paths under a tmp root (itself reached via /tmp symlinks on
      // macOS) resolve without false positives, existing or not.
      expect(resolveArtifactPath(real, "evidence/page.html")).toBe(
        join(real, "evidence", "page.html"),
      );
      expect(resolveArtifactPath(real, "evidence/not-yet-written.html")).toBe(
        join(real, "evidence", "not-yet-written.html"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
