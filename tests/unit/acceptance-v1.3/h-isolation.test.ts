// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function productionSources(): string[] {
  const files: string[] = [];
  for (const dir of ["app", "components", "src"]) {
    for (const file of walk(join(ROOT, dir))) {
      if (file.includes(`${join(ROOT, "app", "mockup")}/`) || file.includes("/app/mockup/")) {
        continue;
      }
      files.push(file);
    }
  }
  return files;
}

describe("WO-1.3-H static isolation (H2/H8)", () => {
  it("production never imports mockup modules (H8)", () => {
    const offenders: string[] = [];
    for (const file of productionSources()) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (/^\s*import\b.*mockup/i.test(line) || /from\s+["'][^"']*mockup/i.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("production navigation never links to /mockup (H8)", () => {
    const offenders: string[] = [];
    for (const file of productionSources()) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (/href\s*=\s*["']\/mockup/i.test(line) || /router\.(push|replace)\(\s*["']\/mockup/i.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the board shell imports no legacy drawer mutation modules (H2)", () => {
    const shell = [
      "components/board/Board.tsx",
      "components/board/BoardColumn.tsx",
      "components/board/JobCard.tsx",
      "components/board/CardDrawer.tsx",
      "components/board/TailorEntryPanel.tsx",
    ];
    const offenders: string[] = [];
    for (const rel of shell) {
      const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (/from\s+["'][^"']*board\/(ResumeReview|tailoringCopy)/.test(line)) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
