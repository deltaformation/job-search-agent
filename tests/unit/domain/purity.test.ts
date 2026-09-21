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

describe("resumes purity", () => {
  // Pure subset: view model, projections, template, config, checks,
  // artifact metadata. They may use Zod, siblings, shared domain and
  // tailoring contracts, node:crypto, and the pure HTML parser — but
  // never touch the filesystem, network, browser, or document SDKs.
  const PURE_RESUMES_FILES = [
    "viewModel.ts",
    "markdown.ts",
    "template.ts",
    "config.ts",
    "checks.ts",
    "artifacts.ts",
  ];

  it("keeps the pure subset free of IO and document SDKs", () => {
    const pure = moduleImports("resumes").filter(({ file }) => PURE_RESUMES_FILES.includes(file));
    expect(pure.length).toBeGreaterThan(0);
    const violations = pure.filter(
      ({ specifier }) =>
        specifier !== "zod" &&
        specifier !== "zod/v4" &&
        specifier !== "node:crypto" &&
        specifier !== "node-html-parser" &&
        !specifier.startsWith("./") &&
        !specifier.startsWith("../domain/") &&
        !specifier.startsWith("../tailoring/"),
    );
    expect(violations).toEqual([]);
  });

  it("never imports frameworks, drivers, or provider SDKs", () => {
    // Playwright is the sanctioned PDF renderer (AGENTS.md); everything
    // else on the forbidden list stays banned.
    const hits = moduleImports("resumes").filter(
      ({ specifier }) =>
        specifier !== "playwright" &&
        FORBIDDEN_IMPORTS.some(
          (banned) => specifier === banned || specifier.startsWith(`${banned}/`),
        ),
    );
    expect(hits).toEqual([]);
  });

  it("confines browser access to the PDF renderer", () => {
    const hits = moduleImports("resumes").filter(
      ({ file, specifier }) => specifier === "playwright" && file !== "pdf.ts",
    );
    expect(hits).toEqual([]);
  });

  it("confines filesystem access to the template/DOCX loaders", () => {
    const hits = moduleImports("resumes").filter(
      ({ file, specifier }) =>
        (specifier === "node:fs" || specifier === "node:url") && file !== "docx.ts",
    );
    expect(hits).toEqual([]);
  });
});

describe("tailoring purity", () => {
  // R4-C core plus R4-E deterministic modules stay pure. The R4-E
  // orchestration edge (commandAdapter, enqueue, handler, orchestrate,
  // persist, publish) is the sanctioned IO boundary, confined below.
  const PURE_TAILORING_FILES = [
    "adapt.ts",
    "audit.ts",
    "contract.ts",
    "draft.ts",
    "hash.ts",
    "keywords.ts",
    "primitives.ts",
    "ranking.ts",
    "schemas.ts",
    "staleness.ts",
    "step2CorrectionPolicy.ts",
    "step2policy.ts",
    "summary.ts",
    "testProvider.ts",
    "text.ts",
    "validator.ts",
  ];

  it("keeps the pure subset free of IO and services", () => {
    const pure = moduleImports("tailoring").filter(({ file }) =>
      PURE_TAILORING_FILES.includes(file),
    );
    expect(pure.length).toBeGreaterThan(0);
    const violations = pure.filter(
      ({ specifier }) =>
        specifier !== "zod" &&
        specifier !== "zod/v4" &&
        specifier !== "../resumes/config" &&
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

  it("confines subprocess use to the command adapter", () => {
    const hits = moduleImports("tailoring").filter(
      ({ file, specifier }) =>
        (specifier === "node:child_process" || specifier.startsWith("node:child_process/")) &&
        file !== "commandAdapter.ts",
    );
    expect(hits).toEqual([]);
  });

  it("confines filesystem use to artifact publishing", () => {
    const hits = moduleImports("tailoring").filter(
      ({ file, specifier }) =>
        (specifier === "node:fs" || specifier.startsWith("node:fs/")) && file !== "publish.ts",
    );
    expect(hits).toEqual([]);
  });

  it("never touches the network or worker threads", () => {
    const hits = moduleImports("tailoring").filter(({ specifier }) =>
      ["node:net", "node:http", "node:worker_threads"].some(
        (banned) => specifier === banned || specifier.startsWith(`${banned}/`),
      ),
    );
    expect(hits).toEqual([]);
  });
});
