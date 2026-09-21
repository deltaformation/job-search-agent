/**
 * Pure bounded master-versus-tailored diff for exact-version review
 * (WO-1.3-G). Production reimplementation of the verified prototype
 * structure (`app/mockup/utils/lineDiff.ts`); production never imports
 * the mockup.
 *
 * Guarantees:
 * - Blank lines and interior spaces are preserved verbatim; only
 *   CRLF is normalized to LF and exactly one trailing-newline
 *   artifact line is dropped.
 * - Bounded work: when (masterLines+1)*(tailoredLines+1) exceeds
 *   DIFF_WORK_BUDGET, or either side exceeds MAX_DIFF_LINES, the
 *   caller gets a full-text fallback (both complete texts, an
 *   explicit unavailable notice) — never truncated content, never a
 *   hang. Memory is O(cells) capped by the same budget.
 * - Deterministic LCS pairing identical in spirit to the prototype:
 *   del/add runs pair into aligned `change` rows; leftovers stay
 *   pure removals/additions.
 * - v2/v3 tailored lines attribute to their frozen source segments
 *   by EXACT text equality against the frozen segment set (never
 *   fuzzy matching): `- <bullet>` lines consume matching bullet
 *   segments in order (nth duplicate line takes the nth duplicate
 *   segment); summary-section lines attribute to the summary
 *   segment. Unmatched lines are unattributed, never misattributed.
 * - Master lines removed by an explicit exclude op render as
 *   excluded (exact excluded-text match); excluded content is never
 *   resurrected tailored-side (the worker omits it; the diff only
 *   labels the master side).
 * - Every row carries non-color markers (text glyphs + provenance
 *   tags), so the diff is never color-only.
 *
 * Pure domain module: no Next.js, Drizzle, Playwright, or provider
 * imports. Both the server (insight stats) and the Step 4 client
 * (interactive diff) use this module.
 */

export const DIFF_WORK_BUDGET = 1_000_000;
export const MAX_DIFF_LINES = 10_000;

export type ReviewDiffRowKind = "same" | "del" | "add" | "change";

export type ReviewDiffProvenance =
  | "VERIFIED_SOURCE"
  | "USER_ACCEPTED_AI"
  | "USER_EDITED";

export interface ReviewDiffSegment {
  segmentId: string;
  kind: "summary" | "bullet";
  roleId: string | null;
  /** Exact frozen segment text (verbatim bytes). */
  text: string;
  provenance: ReviewDiffProvenance;
  sourceOperationId: string | null;
}

export interface ReviewDiffInput {
  masterText: string;
  tailoredText: string;
  /** Frozen edited segments (v2/v3); empty for v1-focus/legacy rows. */
  segments: ReviewDiffSegment[];
  /** Exact master bullet texts removed by explicit exclude ops. */
  excludedMasterTexts: string[];
}

export interface ReviewDiffAttribution {
  segmentId: string;
  provenance: ReviewDiffProvenance;
  sourceOperationId: string | null;
}

export interface ReviewDiffRow {
  kind: ReviewDiffRowKind;
  /** 1-based master line number, or null for additions. */
  leftNo: number | null;
  /** 1-based tailored line number, or null for removals. */
  rightNo: number | null;
  left: string | null;
  right: string | null;
  /** Master line removed by an explicit exclude op. */
  leftExcluded: boolean;
  /**
   * Tailored-side attribution (preferred); master-side verified
   * baseline lines carry no segment attribution.
   */
  attribution: ReviewDiffAttribution | null;
  /**
   * Non-color row marker: " " (same), "-" (removed), "+" (added),
   * "~" (changed). Rendered as text, never color alone.
   */
  marker: " " | "-" | "+" | "~";
  /**
   * Non-color provenance tag for attributed lines: "V" (verified
   * source), "A" (AI suggestion accepted), "E" (user edit).
   * Null for unattributed lines.
   */
  provenanceTag: "V" | "A" | "E" | null;
}

export interface ReviewDiffSection {
  title: string;
  rows: ReviewDiffRow[];
  changed: boolean;
}

export interface ReviewDiffResult {
  /** False when the work budget tripped: render the fallback. */
  diffAvailable: boolean;
  /** "ok" or the budget that tripped (never silent). */
  reason: "ok" | "over-work-budget" | "over-line-cap";
  rows: ReviewDiffRow[];
  sections: ReviewDiffSection[];
  removals: number;
  additions: number;
  /** (masterLines+1)*(tailoredLines+1) offered to the LCS. */
  workUnits: number;
}

/** Split preserving blanks/spaces; drop one trailing artifact line. */
export function splitReviewLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Escape hostile text for raw-HTML contexts. React clients render
 * diff lines as string children (auto-escaped); this helper covers
 * any non-React sink and pins the G6 escaping contract.
 */
export function escapeReviewHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function provenanceTagFor(
  provenance: ReviewDiffProvenance,
): "V" | "A" | "E" {
  switch (provenance) {
    case "VERIFIED_SOURCE":
      return "V";
    case "USER_ACCEPTED_AI":
      return "A";
    case "USER_EDITED":
      return "E";
  }
}

/**
 * Exact segment index: bullet text -> segment queue in segment
 * order, plus the single summary segment. Matching is exact string
 * equality only; duplicates consume in order (nth line takes the
 * nth segment), so attribution is deterministic and never fuzzy.
 */
interface SegmentIndex {
  bullets: Map<string, ReviewDiffSegment[]>;
  summary: ReviewDiffSegment | null;
}

function buildSegmentIndex(segments: ReviewDiffSegment[]): SegmentIndex {
  const bullets = new Map<string, ReviewDiffSegment[]>();
  let summary: ReviewDiffSegment | null = null;
  for (const segment of segments) {
    if (segment.kind === "summary") {
      summary ??= segment;
      continue;
    }
    const list = bullets.get(segment.text) ?? [];
    list.push(segment);
    bullets.set(segment.text, list);
  }
  return { bullets, summary };
}

function takeBulletSegment(
  index: SegmentIndex,
  text: string,
): ReviewDiffSegment | null {
  const list = index.bullets.get(text);
  if (list === undefined || list.length === 0) {
    return null;
  }
  const segment = list.shift();
  return segment ?? null;
}

function toAttribution(segment: ReviewDiffSegment): ReviewDiffAttribution {
  return {
    segmentId: segment.segmentId,
    provenance: segment.provenance,
    sourceOperationId: segment.sourceOperationId,
  };
}

function sectionTitleFor(line: string | null): string | null {
  if (line === null) {
    return null;
  }
  const match = /^##\s+(.*)$/.exec(line);
  return match ? match[1].trim() : null;
}

/** Groups aligned rows by `## ` section markers for the filter. */
export function groupReviewRows(rows: ReviewDiffRow[]): ReviewDiffSection[] {
  const sections: ReviewDiffSection[] = [];
  let current: ReviewDiffSection = { title: "Header", rows: [], changed: false };
  for (const row of rows) {
    const marker = sectionTitleFor(row.left) ?? sectionTitleFor(row.right);
    if (marker !== null && row.kind === "same") {
      if (current.rows.length > 0 || sections.length === 0) {
        sections.push(current);
      }
      current = { title: marker, rows: [], changed: false };
    }
    if (row.kind !== "same") {
      current.changed = true;
    }
    current.rows.push(row);
  }
  sections.push(current);
  return sections.filter(
    (section, index) => section.rows.length > 0 || index === 0,
  );
}

function countDiffChanges(rows: ReviewDiffRow[]): {
  removals: number;
  additions: number;
} {
  let removals = 0;
  let additions = 0;
  for (const row of rows) {
    if (row.kind === "del" || row.kind === "change") {
      removals += 1;
    }
    if (row.kind === "add" || row.kind === "change") {
      additions += 1;
    }
  }
  return { removals, additions };
}

function markerFor(kind: ReviewDiffRowKind): " " | "-" | "+" | "~" {
  switch (kind) {
    case "same":
      return " ";
    case "del":
      return "-";
    case "add":
      return "+";
    case "change":
      return "~";
  }
}

/** Strip one leading "- " bullet marker; null when not a bullet. */
function bulletBody(line: string): string | null {
  return line.startsWith("- ") ? line.slice(2) : null;
}

/**
 * Master bullet bodies carry a trailing fact annotation
 * (`- <text> \`[factId · verification]\``). Strip one leading
 * "- " and one trailing " `[...]`" annotation; sub-bullets
 * ("  - Technologies: ...") are structural and return null.
 */
function masterBulletBody(line: string): string | null {
  if (!line.startsWith("- ") || line.startsWith("  - ")) {
    return null;
  }
  let body = line.slice(2);
  const annotation = body.match(/^(.*) `\[[^\]]*\]`$/);
  if (annotation !== null) {
    body = annotation[1];
  }
  return body;
}

function isSummaryHeading(line: string | null): boolean {
  if (line === null) {
    return false;
  }
  return /^##\s+Summary\s*$/.test(line);
}

function isAnyHeading(line: string | null): boolean {
  return sectionTitleFor(line) !== null;
}

export function diffReviewTexts(input: ReviewDiffInput): ReviewDiffResult {
  const master = splitReviewLines(input.masterText);
  const tailored = splitReviewLines(input.tailoredText);
  const workUnits = (master.length + 1) * (tailored.length + 1);

  if (master.length > MAX_DIFF_LINES || tailored.length > MAX_DIFF_LINES) {
    return {
      diffAvailable: false,
      reason: "over-line-cap",
      rows: [],
      sections: [],
      removals: 0,
      additions: 0,
      workUnits,
    };
  }
  if (workUnits > DIFF_WORK_BUDGET) {
    return {
      diffAvailable: false,
      reason: "over-work-budget",
      rows: [],
      sections: [],
      removals: 0,
      additions: 0,
      workUnits,
    };
  }

  // LCS suffix table over exact line equality (flat Int32Array:
  // memory is O(workUnits), capped by the budget above).
  const n = master.length;
  const m = tailored.length;
  const stride = m + 1;
  const table = new Int32Array((n + 1) * (m + 1));
  const at = (i: number, j: number): number => table[i * stride + j] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * stride + j] =
        master[i] === tailored[j]
          ? (table[(i + 1) * stride + (j + 1)] ?? 0) + 1
          : Math.max(
              table[(i + 1) * stride + j] ?? 0,
              table[i * stride + (j + 1)] ?? 0,
            );
    }
  }

  type Op = { kind: "same" | "del" | "add"; text: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (master[i] === tailored[j]) {
      ops.push({ kind: "same", text: master[i] as string });
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ kind: "del", text: master[i] as string });
      i += 1;
    } else {
      ops.push({ kind: "add", text: tailored[j] as string });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", text: master[i] as string });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "add", text: tailored[j] as string });
    j += 1;
  }

  // Pair del/add runs into aligned change rows; leftovers stay pure.
  interface Aligned {
    kind: ReviewDiffRowKind;
    leftNo: number | null;
    rightNo: number | null;
    left: string | null;
    right: string | null;
  }
  const aligned: Aligned[] = [];
  let leftNo = 1;
  let rightNo = 1;
  let k = 0;
  while (k < ops.length) {
    const op = ops[k] as Op;
    if (op.kind === "same") {
      aligned.push({ kind: "same", leftNo, rightNo, left: op.text, right: op.text });
      leftNo += 1;
      rightNo += 1;
      k += 1;
      continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    while (k < ops.length && (ops[k] as Op).kind !== "same") {
      const run = ops[k] as Op;
      if (run.kind === "del") {
        dels.push(run.text);
      } else {
        adds.push(run.text);
      }
      k += 1;
    }
    const paired = Math.min(dels.length, adds.length);
    for (let p = 0; p < paired; p += 1) {
      aligned.push({
        kind: "change",
        leftNo,
        rightNo,
        left: dels[p] as string,
        right: adds[p] as string,
      });
      leftNo += 1;
      rightNo += 1;
    }
    for (let p = paired; p < dels.length; p += 1) {
      aligned.push({ kind: "del", leftNo, rightNo: null, left: dels[p] as string, right: null });
      leftNo += 1;
    }
    for (let p = paired; p < adds.length; p += 1) {
      aligned.push({ kind: "add", leftNo: null, rightNo, left: null, right: adds[p] as string });
      rightNo += 1;
    }
  }

  // Attribution pass (exact only). Bullet lines consume matching
  // bullet segments in tailored order; summary-section lines take
  // the summary segment; master excluded bullets are labeled from
  // the frozen excluded-text set.
  const index = buildSegmentIndex(input.segments);
  const excluded = new Set(input.excludedMasterTexts);
  let inTailoredSummary = false;
  const rows: ReviewDiffRow[] = aligned.map((row) => {
    if (isAnyHeading(row.right) || (row.right === null && isAnyHeading(row.left))) {
      inTailoredSummary = isSummaryHeading(row.right) || isSummaryHeading(row.left);
    }
    let attribution: ReviewDiffAttribution | null = null;
    if (row.right !== null) {
      const body = bulletBody(row.right);
      if (body !== null) {
        const segment = takeBulletSegment(index, body);
        if (segment !== null) {
          attribution = toAttribution(segment);
        }
      } else if (inTailoredSummary && index.summary !== null && row.right.trim() !== "") {
        attribution = toAttribution(index.summary);
      }
    }
    let leftExcluded = false;
    if (row.left !== null && (row.kind === "del" || row.kind === "change")) {
      const body = masterBulletBody(row.left);
      if (body !== null && excluded.has(body)) {
        leftExcluded = true;
      }
    }
    return {
      kind: row.kind,
      leftNo: row.leftNo,
      rightNo: row.rightNo,
      left: row.left,
      right: row.right,
      leftExcluded,
      attribution,
      marker: markerFor(row.kind),
      provenanceTag:
        attribution === null ? null : provenanceTagFor(attribution.provenance),
    };
  });

  const sections = groupReviewRows(rows);
  const { removals, additions } = countDiffChanges(rows);
  return {
    diffAvailable: true,
    reason: "ok",
    rows,
    sections,
    removals,
    additions,
    workUnits,
  };
}

/** Strip `## `/`### ` markers for display; all other text verbatim. */
export function displayReviewLine(line: string): {
  text: string;
  level: 0 | 2 | 3;
} {
  if (line.startsWith("### ")) {
    return { text: line.slice(4), level: 3 };
  }
  if (line.startsWith("## ")) {
    return { text: line.slice(3), level: 2 };
  }
  return { text: line, level: 0 };
}
