/**
 * mockup2 line diff — pure module (no React). Computes an LCS-based line diff
 * between the master and tailored fixtures and pairs change runs into aligned
 * side-by-side rows. Whitespace, line breaks, and blank lines are preserved.
 */

export type SideRowKind = "same" | "del" | "add" | "change";

export interface SideRow {
  kind: SideRowKind;
  /** 1-based line number in the master text, or null for additions. */
  leftNo: number | null;
  /** 1-based line number in the tailored text, or null for removals. */
  rightNo: number | null;
  left: string | null;
  right: string | null;
}

export interface DiffSection {
  /** Section title from the `## ` marker, or "Header" for leading lines. */
  title: string;
  rows: SideRow[];
  changed: boolean;
}

export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  // A trailing newline produces a final empty artifact line; drop exactly one.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Minimal line diff via LCS dynamic programming. Resume fixtures are small
 * (~70 lines), so the O(n*m) table is cheap and exact.
 */
export function diffLines(master: string[], tailored: string[]): SideRow[] {
  const n = master.length;
  const m = tailored.length;
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] =
        master[i] === tailored[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  type Op = { kind: "same" | "del" | "add"; text: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (master[i] === tailored[j]) {
      ops.push({ kind: "same", text: master[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: "del", text: master[i] });
      i += 1;
    } else {
      ops.push({ kind: "add", text: tailored[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", text: master[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "add", text: tailored[j] });
    j += 1;
  }

  // Pair del/add runs into aligned change rows; keep runs aligned line by
  // line and emit leftovers as pure removals/additions.
  const rows: SideRow[] = [];
  let leftNo = 1;
  let rightNo = 1;
  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.kind === "same") {
      rows.push({ kind: "same", leftNo, rightNo, left: op.text, right: op.text });
      leftNo += 1;
      rightNo += 1;
      k += 1;
      continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    while (k < ops.length && ops[k].kind !== "same") {
      if (ops[k].kind === "del") {
        dels.push(ops[k].text);
      } else {
        adds.push(ops[k].text);
      }
      k += 1;
    }
    const paired = Math.min(dels.length, adds.length);
    for (let p = 0; p < paired; p += 1) {
      rows.push({
        kind: "change",
        leftNo,
        rightNo,
        left: dels[p],
        right: adds[p],
      });
      leftNo += 1;
      rightNo += 1;
    }
    for (let p = paired; p < dels.length; p += 1) {
      rows.push({ kind: "del", leftNo, rightNo: null, left: dels[p], right: null });
      leftNo += 1;
    }
    for (let p = paired; p < adds.length; p += 1) {
      rows.push({ kind: "add", leftNo: null, rightNo, left: null, right: adds[p] });
      rightNo += 1;
    }
  }
  return rows;
}

function sectionTitleFor(line: string | null): string | null {
  if (line === null) {
    return null;
  }
  const match = /^##\s+(.*)$/.exec(line);
  return match ? match[1].trim() : null;
}

/** Groups aligned rows by `## ` section markers for the section filter. */
export function groupBySection(rows: SideRow[]): DiffSection[] {
  const sections: DiffSection[] = [];
  let current: DiffSection = { title: "Header", rows: [], changed: false };
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
  return sections.filter((section, index) => section.rows.length > 0 || index === 0);
}

/** Strips `## `/`### ` markers for display; all other text is verbatim. */
export function displayLine(line: string): { text: string; level: 0 | 2 | 3 } {
  if (line.startsWith("### ")) {
    return { text: line.slice(4), level: 3 };
  }
  if (line.startsWith("## ")) {
    return { text: line.slice(3), level: 2 };
  }
  return { text: line, level: 0 };
}

export function countChanges(rows: SideRow[]): { removals: number; additions: number } {
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
