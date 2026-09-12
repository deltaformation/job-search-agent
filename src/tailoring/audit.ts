/**
 * Deterministic change summary: baseline-vs-tailored comparison without
 * a line-diff dependency. Bullet lines use the plain-text projection's
 * `"  - "` prefix; added/removed sets are unique lines in first-seen
 * order, so identical inputs always produce identical summaries.
 */

export interface ChangeSummary {
  addedBullets: string[];
  removedBullets: string[];
  summaryChanged: boolean;
  baselineLines: number;
  tailoredLines: number;
}

const BULLET_PREFIX = "  - ";

function bulletLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith(BULLET_PREFIX))
    .map((line) => line.slice(BULLET_PREFIX.length));
}

function orderedUnique(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}

export function summarizeChanges(input: {
  baselineText: string;
  tailoredText: string;
  baselineSummary: string;
  tailoredSummary: string;
}): ChangeSummary {
  const baselineBullets = new Set(bulletLines(input.baselineText));
  const tailoredBullets = new Set(bulletLines(input.tailoredText));
  return {
    addedBullets: orderedUnique(
      [...tailoredBullets].filter((line) => !baselineBullets.has(line)),
    ),
    removedBullets: orderedUnique(
      [...baselineBullets].filter((line) => !tailoredBullets.has(line)),
    ),
    summaryChanged: input.baselineSummary !== input.tailoredSummary,
    baselineLines: input.baselineText.split("\n").length,
    tailoredLines: input.tailoredText.split("\n").length,
  };
}
