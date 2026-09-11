// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Purity guard: domain modules are portable contracts. They may import Zod
 * and each other, but never frameworks, drivers, or provider SDKs, and never
 * escape their own directory.
 */
const FORBIDDEN_IMPORTS = [
  "next",
  "drizzle-orm",
  "drizzle-kit",
  "better-sqlite3",
  "playwright",
  "@playwright/test",
  "openai",
  "anthropic",
  "@anthropic-ai/sdk",
  "@google/generative-ai",
  "ollama",
];

function moduleImports(subdir: string): Array<{ file: string; specifier: string }> {
  const dir = join(process.cwd(), "src", subdir);
  const found: Array<{ file: string; specifier: string }> = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const pattern of [
      /\bfrom\s+["']([^"']+)["']/g,
      /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    ]) {
      for (const match of text.matchAll(pattern)) {
        found.push({ file, specifier: match[1] });
      }
    }
  }
  return found;
}

describe("domain purity", () => {
  it("imports only zod and sibling domain modules", () => {
    const violations = moduleImports("domain").filter(
      ({ specifier }) =>
        specifier !== "zod" &&
        specifier !== "zod/v4" &&
        !specifier.startsWith("./"),
    );
    expect(violations).toEqual([]);
  });

  it("never imports frameworks, drivers, or provider SDKs", () => {
    const hits = moduleImports("domain").filter(({ specifier }) =>
      FORBIDDEN_IMPORTS.some(
        (banned) => specifier === banned || specifier.startsWith(`${banned}/`),
      ),
    );
    expect(hits).toEqual([]);
  });

  it("never escapes its own directory", () => {
    const escapes = moduleImports("domain").filter(({ specifier }) =>
      specifier.includes(".."),
    );
    expect(escapes).toEqual([]);
  });
});

describe("tailoring purity", () => {
  it("imports only zod, siblings, shared domain primitives, and node:crypto", () => {
    const violations = moduleImports("tailoring").filter(
      ({ specifier }) =>
        specifier !== "zod" &&
        specifier !== "zod/v4" &&
        !specifier.startsWith("./") &&
        !specifier.startsWith("../domain/") &&
        !specifier.startsWith("node:"),
    );
    expect(violations).toEqual([]);
  });

  it("never imports frameworks, drivers, or provider SDKs", () => {
    const hits = moduleImports("tailoring").filter(({ specifier }) =>
      FORBIDDEN_IMPORTS.some(
        (banned) => specifier === banned || specifier.startsWith(`${banned}/`),
      ),
    );
    expect(hits).toEqual([]);
  });

  it("never touches the filesystem, network, or subprocesses", () => {
    const hits = moduleImports("tailoring").filter(({ specifier }) =>
      ["node:fs", "node:net", "node:http", "node:child_process", "node:worker_threads"].some(
        (banned) => specifier === banned || specifier.startsWith(`${banned}/`),
      ),
    );
    expect(hits).toEqual([]);
  });
});
