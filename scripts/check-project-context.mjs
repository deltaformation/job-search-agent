#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const requiredFiles = [
  "PROJECT.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "README.md",
  "docs/README.md",
  "docs/architecture.md",
  "docs/decisions.md",
  "docs/operations.md",
  "docs/status.md",
  "docs/ui-ux-design-spec.md",
];

const removedHarnessPaths = [
  ".nimbalyst",
  "nimbalyst-local",
  "scripts/populate_nimbalyst.py",
  "tests/test_nimbalyst_workspace.py",
];

const activeEntrypoints = [
  "PROJECT.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "README.md",
  "docs/README.md",
  "docs/architecture.md",
  "docs/decisions.md",
  "docs/operations.md",
  "docs/status.md",
  "docs/ui-ux-design-spec.md",
];

const staleReferencePatterns = [
  /nimbalyst-local\//i,
  /\.nimbalyst\//i,
  /populate_nimbalyst\.py/i,
];

const errors = [];

for (const relativePath of requiredFiles) {
  const absolutePath = resolve(root, relativePath);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    errors.push(`missing required context file: ${relativePath}`);
    continue;
  }
  if (statSync(absolutePath).size === 0) {
    errors.push(`empty required context file: ${relativePath}`);
  }
}

for (const relativePath of removedHarnessPaths) {
  if (existsSync(resolve(root, relativePath))) {
    errors.push(`retired harness path still exists: ${relativePath}`);
  }
}

for (const relativePath of activeEntrypoints) {
  const absolutePath = resolve(root, relativePath);
  if (!existsSync(absolutePath)) {
    continue;
  }
  const text = readFileSync(absolutePath, "utf8");
  for (const pattern of staleReferencePatterns) {
    if (pattern.test(text)) {
      errors.push(`stale retired-harness link in ${relativePath}: ${pattern}`);
    }
  }
}

const canonicalMarkdownFiles = requiredFiles.filter((path) => path.endsWith(".md"));
const markdownLinkPattern = /\[[^\]]*\]\(([^)]+)\)/g;

for (const relativePath of canonicalMarkdownFiles) {
  const absolutePath = resolve(root, relativePath);
  if (!existsSync(absolutePath)) {
    continue;
  }
  const text = readFileSync(absolutePath, "utf8");
  for (const match of text.matchAll(markdownLinkPattern)) {
    const target = match[1].trim();
    if (
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("#") ||
      target.startsWith("mailto:")
    ) {
      continue;
    }
    const pathOnly = target.split("#", 1)[0];
    const resolvedTarget = resolve(dirname(absolutePath), pathOnly);
    if (!existsSync(resolvedTarget)) {
      errors.push(`broken local link in ${relativePath}: ${target}`);
    }
  }
}

if (errors.length > 0) {
  process.stderr.write("Project context check failed:\n");
  for (const error of errors) {
    process.stderr.write(`- ${error}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Project context is consistent: ${requiredFiles.length} required files, ` +
      `${activeEntrypoints.length} active entrypoints, retired harness absent.\n`,
  );
}
