export type DiffLineType = "unchanged" | "added" | "removed" | "empty";

export interface DiffRow {
  id: string;
  leftLineNumber: number | null;
  leftContent: string;
  rightLineNumber: number | null;
  rightContent: string;
  type: "unchanged" | "modified" | "added" | "removed";
  sectionHeader?: string;
  isSectionHeader?: boolean;
}

export interface UnifiedDiffLine {
  id: string;
  type: "unchanged" | "added" | "removed";
  lineNumberLeft: number | null;
  lineNumberRight: number | null;
  content: string;
  sectionHeader?: string;
}

export interface DiffSection {
  title: string;
  hasChanges: boolean;
  rows: DiffRow[];
  unifiedLines: UnifiedDiffLine[];
}

/**
 * Standard Longest Common Subsequence (LCS) line diff algorithm.
 * Guarantees deterministic, truthful diff generation directly from two strings.
 */
export function computeLineDiff(originalText: string, tailoredText: string): {
  sections: DiffSection[];
  totalAdditions: number;
  totalDeletions: number;
  totalUnchanged: number;
} {
  const origLines = originalText.split(/\r?\n/);
  const tailLines = tailoredText.split(/\r?\n/);

  const m = origLines.length;
  const n = tailLines.length;

  // Build DP table
  // Optimized for moderate size documents (~100-300 lines)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (origLines[i - 1] === tailLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack to find aligned operations
  type RawDiffItem =
    | { type: "unchanged"; orig: string; tail: string; origIdx: number; tailIdx: number }
    | { type: "removed"; orig: string; origIdx: number }
    | { type: "added"; tail: string; tailIdx: number };

  const rawDiff: RawDiffItem[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && origLines[i - 1] === tailLines[j - 1]) {
      rawDiff.push({
        type: "unchanged",
        orig: origLines[i - 1]!,
        tail: tailLines[j - 1]!,
        origIdx: i,
        tailIdx: j,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      rawDiff.push({
        type: "added",
        tail: tailLines[j - 1]!,
        tailIdx: j,
      });
      j--;
    } else if (i > 0 && (j === 0 || dp[i]![j - 1]! < dp[i - 1]![j]!)) {
      rawDiff.push({
        type: "removed",
        orig: origLines[i - 1]!,
        origIdx: i,
      });
      i--;
    }
  }

  rawDiff.reverse();

  // Now group raw diff into aligned side-by-side rows and unified lines
  const sideBySideRows: DiffRow[] = [];
  const unifiedLines: UnifiedDiffLine[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;
  let totalUnchanged = 0;

  let rowCounter = 0;
  let k = 0;

  while (k < rawDiff.length) {
    const item = rawDiff[k]!;

    if (item.type === "unchanged") {
      rowCounter++;
      totalUnchanged++;
      const isHeader =
        item.orig.startsWith("#") ||
        item.orig.startsWith("##") ||
        item.orig.startsWith("###") ||
        /^[A-Z\s]{4,}$/.test(item.orig.trim());

      sideBySideRows.push({
        id: `row-${rowCounter}`,
        leftLineNumber: item.origIdx,
        leftContent: item.orig,
        rightLineNumber: item.tailIdx,
        rightContent: item.tail,
        type: "unchanged",
        isSectionHeader: isHeader,
      });

      unifiedLines.push({
        id: `uni-${rowCounter}`,
        type: "unchanged",
        lineNumberLeft: item.origIdx,
        lineNumberRight: item.tailIdx,
        content: item.orig,
      });
      k++;
    } else {
      // Gather contiguous deletions and additions
      const removedBlock: { orig: string; origIdx: number }[] = [];
      const addedBlock: { tail: string; tailIdx: number }[] = [];

      while (k < rawDiff.length && rawDiff[k]!.type !== "unchanged") {
        const nextItem = rawDiff[k]!;
        if (nextItem.type === "removed") {
          removedBlock.push({ orig: nextItem.orig, origIdx: nextItem.origIdx });
          totalDeletions++;
        } else if (nextItem.type === "added") {
          addedBlock.push({ tail: nextItem.tail, tailIdx: nextItem.tailIdx });
          totalAdditions++;
        }
        k++;
      }

      // Add to unified stream first
      for (const r of removedBlock) {
        unifiedLines.push({
          id: `uni-rem-${r.origIdx}`,
          type: "removed",
          lineNumberLeft: r.origIdx,
          lineNumberRight: null,
          content: r.orig,
        });
      }
      for (const a of addedBlock) {
        unifiedLines.push({
          id: `uni-add-${a.tailIdx}`,
          type: "added",
          lineNumberLeft: null,
          lineNumberRight: a.tailIdx,
          content: a.tail,
        });
      }

      // Align side-by-side rows
      const maxLen = Math.max(removedBlock.length, addedBlock.length);
      for (let step = 0; step < maxLen; step++) {
        rowCounter++;
        const rem = removedBlock[step];
        const add = addedBlock[step];

        if (rem && add) {
          sideBySideRows.push({
            id: `row-mod-${rowCounter}`,
            leftLineNumber: rem.origIdx,
            leftContent: rem.orig,
            rightLineNumber: add.tailIdx,
            rightContent: add.tail,
            type: "modified",
          });
        } else if (rem) {
          sideBySideRows.push({
            id: `row-rem-${rowCounter}`,
            leftLineNumber: rem.origIdx,
            leftContent: rem.orig,
            rightLineNumber: null,
            rightContent: "",
            type: "removed",
          });
        } else if (add) {
          sideBySideRows.push({
            id: `row-add-${rowCounter}`,
            leftLineNumber: null,
            leftContent: "",
            rightLineNumber: add.tailIdx,
            rightContent: add.tail,
            type: "added",
          });
        }
      }
    }
  }

  // Partition rows into logical sections (e.g. Header, Summary, Experience, Skills, Education)
  const sections: DiffSection[] = [];
  let currentSectionTitle = "Header & Contact";
  let currentRows: DiffRow[] = [];
  let currentUni: UnifiedDiffLine[] = [];

  function flushSection() {
    if (currentRows.length > 0) {
      const hasChanges = currentRows.some((r) => r.type !== "unchanged");
      sections.push({
        title: currentSectionTitle,
        hasChanges,
        rows: [...currentRows],
        unifiedLines: [...currentUni],
      });
      currentRows = [];
      currentUni = [];
    }
  }

  for (let idx = 0; idx < sideBySideRows.length; idx++) {
    const row = sideBySideRows[idx]!;
    const uni = unifiedLines[idx]!;

    const cleanLeft = row.leftContent.trim();
    const cleanRight = row.rightContent.trim();
    const isMajorHeading =
      cleanLeft.startsWith("## ") ||
      cleanRight.startsWith("## ") ||
      cleanLeft === "SUMMARY" ||
      cleanLeft === "PROFESSIONAL EXPERIENCE" ||
      cleanLeft === "EARLIER CAREER" ||
      cleanLeft === "SKILLS" ||
      cleanLeft === "EDUCATION";

    if (isMajorHeading && currentRows.length > 0) {
      flushSection();
      currentSectionTitle = (cleanLeft || cleanRight).replace(/^##\s*/, "");
    }

    currentRows.push(row);
    currentUni.push(uni);
  }

  flushSection();

  return {
    sections,
    totalAdditions,
    totalDeletions,
    totalUnchanged,
  };
}
