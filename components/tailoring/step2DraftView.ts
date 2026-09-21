import type { StoredProfilePayload } from "@/src/domain/candidate";
import { canonicalJson } from "@/src/domain/canonical";
import {
  checkStep2Budgets,
  STEP2_BUDGETS,
  type MasterBullet,
  type PreparationPlanV1,
  type Step2DraftOperationV1,
  type Step2ValidationV1,
} from "@/src/domain/step2";
import {
  PROVENANCE_REVIEW_LABELS,
  type PreparationPlanV2,
  type Step2DraftOperationV2,
  type Step2Provenance,
  type Step2ValidationV2,
} from "@/src/domain/step2Correction";

export type Step2SegmentVerdict = Step2ValidationV1["segments"][number];

/**
 * Step 2 editor view model (WO-1.3-S2-C): pure projection of the
 * captured master bullets plus ordered draft operations into
 * role-grouped display rows. No fetches, no DOM, no timestamps —
 * the component owns effects, this module owns the mapping so the
 * editor tests can pin order/group/undo semantics exactly.
 */

export interface AppliedBulletRow {
  key: string;
  roleId: string;
  kind: "master" | "added" | "replaced";
  /** Master attribution; null for added suggestion instances. */
  factId: string | null;
  suggestionId: string | null;
  /** Owning op (add/replace) for undo; null for untouched master rows. */
  operationId: string | null;
  text: string;
  baseText: string;
  excluded: boolean;
  excludeOperationId: string | null;
  edited: boolean;
  editOperationId: string | null;
  /** True when the row names a suggestion the bound plan lacks. */
  orphan: boolean;
}

export interface BulletRoleGroup {
  roleId: string;
  rows: AppliedBulletRow[];
}

function masterRow(bullet: MasterBullet): AppliedBulletRow {
  return {
    key: `master:${bullet.factId}`,
    roleId: bullet.roleId,
    kind: "master",
    factId: bullet.factId,
    suggestionId: null,
    operationId: null,
    text: bullet.text,
    baseText: bullet.text,
    excluded: false,
    excludeOperationId: null,
    edited: false,
    editOperationId: null,
    orphan: false,
  };
}

/**
 * Apply ordered draft ops over the master projection. Add appends
 * to its role group; replace removes the target master bullet and
 * lands the replacement in the op's role group; exclude flags the
 * master row (never deletes it); edits reword in place. Unknown
 * references render as flagged orphans instead of crashing — the
 * server is the authority that 422s them on save.
 */
/** v1 and v2 drafts keep identical operation shapes (§13.1); the editor shares them. */
export type EditorDraftOperation = Step2DraftOperationV1 | Step2DraftOperationV2;

export function applyStep2Operations(
  master: MasterBullet[],
  plan: PreparationPlanV1 | PreparationPlanV2 | null,
  operations: EditorDraftOperation[],
): BulletRoleGroup[] {
  const suggestions = new Map(
    (plan?.suggestions ?? []).map((suggestion) => [suggestion.suggestionId, suggestion]),
  );
  const groups = new Map<string, AppliedBulletRow[]>();
  const rowsByFact = new Map<string, AppliedBulletRow>();
  const rowsByAddOp = new Map<string, AppliedBulletRow>();

  const listFor = (roleId: string): AppliedBulletRow[] => {
    const existing = groups.get(roleId);
    if (existing !== undefined) {
      return existing;
    }
    const created: AppliedBulletRow[] = [];
    groups.set(roleId, created);
    return created;
  };

  for (const bullet of master) {
    const row = masterRow(bullet);
    listFor(bullet.roleId).push(row);
    if (!rowsByFact.has(bullet.factId)) {
      rowsByFact.set(bullet.factId, row);
    }
  }

  const removeRow = (row: AppliedBulletRow): void => {
    const list = groups.get(row.roleId);
    if (list === undefined) {
      return;
    }
    const index = list.indexOf(row);
    if (index >= 0) {
      list.splice(index, 1);
    }
  };

  for (const op of operations) {
    if (op.op === "add") {
      const suggestion = suggestions.get(op.suggestionId);
      const baseText = suggestion?.text ?? "(unknown suggestion)";
      const row: AppliedBulletRow = {
        key: `add:${op.operationId}`,
        roleId: op.roleId,
        kind: "added",
        factId: null,
        suggestionId: op.suggestionId,
        operationId: op.operationId,
        text: op.editedText ?? baseText,
        baseText,
        excluded: false,
        excludeOperationId: null,
        edited: op.editedText !== null,
        editOperationId: null,
        orphan: suggestion === undefined,
      };
      listFor(op.roleId).push(row);
      rowsByAddOp.set(op.operationId, row);
    } else if (op.op === "replace") {
      const target = op.targetFactId === "" ? undefined : rowsByFact.get(op.targetFactId);
      const suggestion =
        op.suggestionId === null ? undefined : suggestions.get(op.suggestionId);
      const baseText =
        suggestion?.text ?? op.editedText ?? "(unknown replacement)";
      const row: AppliedBulletRow = {
        key: `replace:${op.operationId}`,
        roleId: op.roleId,
        kind: "replaced",
        factId: op.targetFactId,
        suggestionId: op.suggestionId,
        operationId: op.operationId,
        text: op.editedText ?? baseText,
        baseText,
        excluded: false,
        excludeOperationId: null,
        edited: op.editedText !== null,
        editOperationId: null,
        orphan: op.suggestionId !== null && suggestion === undefined,
      };
      if (target !== undefined) {
        removeRow(target);
        rowsByFact.delete(op.targetFactId);
      }
      listFor(op.roleId).push(row);
      rowsByAddOp.set(op.operationId, row);
    } else if (op.op === "exclude") {
      const target = rowsByFact.get(op.targetFactId);
      if (target !== undefined && target.excludeOperationId === null) {
        target.excluded = true;
        target.excludeOperationId = op.operationId;
      }
    } else if (op.target.kind === "bullet") {
      const bullet = rowsByFact.get(op.target.factId);
      if (bullet !== undefined) {
        bullet.text = op.text;
        bullet.edited = true;
        bullet.editOperationId = op.operationId;
      }
    } else {
      const target = op.target;
      if (target.kind !== "suggestion") {
        continue;
      }
      const instance = [...rowsByAddOp.values()].find(
        (row) => row.suggestionId === target.suggestionId,
      );
      if (instance !== undefined) {
        instance.text = op.text;
        instance.edited = true;
        instance.editOperationId = op.operationId;
      }
    }
  }

  return [...groups.entries()].map(([roleId, rows]) => ({ roleId, rows }));
}

/** Role-group order: payload employment order, unlinked last, unknown sorted. */
export function sortRoleGroups(
  groups: BulletRoleGroup[],
  payload: StoredProfilePayload | null,
): BulletRoleGroup[] {
  const order = new Map<string, number>();
  for (const [index, entry] of (payload?.employment ?? []).entries()) {
    order.set(entry.id, index);
  }
  const rank = (roleId: string): number => {
    const known = order.get(roleId);
    if (known !== undefined) {
      return known;
    }
    return roleId === "" ? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER;
  };
  return [...groups].sort((left, right) => {
    const delta = rank(left.roleId) - rank(right.roleId);
    if (delta !== 0) {
      return delta;
    }
    return left.roleId < right.roleId ? -1 : left.roleId > right.roleId ? 1 : 0;
  });
}

export function employmentLabel(
  payload: StoredProfilePayload | null,
  roleId: string,
): { company: string; role: string } | null {
  const entry = payload?.employment.find((item) => item.id === roleId);
  if (entry === undefined) {
    return null;
  }
  return { company: entry.company, role: entry.role };
}

export type SummarySource = "master" | "angle-1" | "angle-2" | "edited";

/** Exact-text summary source for the draft (server recomputes the same way). */
export function summarySourceFor(
  summaryText: string,
  plan: PreparationPlanV1 | PreparationPlanV2 | null,
): SummarySource {
  if (plan !== null && summaryText === plan.positioning.keepMasterSummary) {
    return "master";
  }
  if (plan !== null) {
    for (const angle of plan.positioning.angles) {
      if (summaryText === angle.summaryText) {
        return angle.angleId === "angle-2" ? "angle-2" : "angle-1";
      }
    }
  }
  return "edited";
}

/**
 * Exact-bytes snapshot of the editable draft surface. The editor
 * compares snapshots to decide whether persisted verdicts still
 * describe the current text — no hashes, no timestamps.
 */
/**
 * Which named v2 origin the text matches, if any. The saved v2
 * origin is explicit UI state (edits preserve it); this matcher
 * only highlights the theme picker and seeds fresh drafts.
 */
export function matchSummaryOrigin(
  summaryText: string,
  plan: PreparationPlanV1 | PreparationPlanV2 | null,
): "master" | "angle-1" | "angle-2" | null {
  if (plan !== null && summaryText === plan.positioning.keepMasterSummary) {
    return "master";
  }
  if (plan !== null) {
    for (const angle of plan.positioning.angles) {
      if (summaryText === angle.summaryText) {
        return angle.angleId === "angle-2" ? "angle-2" : "angle-1";
      }
    }
  }
  return null;
}

export function draftSnapshot(
  summaryText: string,
  operations: EditorDraftOperation[],
): string {
  return canonicalJson({ summaryText, operations });
}

export interface BudgetLine {
  key: string;
  label: string;
  used: number;
  limit: number;
  exceeded: boolean;
}

export interface BudgetReport {
  lines: BudgetLine[];
  totalBullets: number;
  summaryChars: number;
  exceeded: boolean;
}

/** Actionable budget lines: summary chars first, then per-role counts, then the total. */
export function budgetLines(
  summaryText: string,
  master: MasterBullet[],
  operations: EditorDraftOperation[],
  payload: StoredProfilePayload | null,
): BudgetReport {
  const report = checkStep2Budgets({ summaryText, master, operations });
  const lines: BudgetLine[] = [
    {
      key: "summary",
      label: "Summary characters",
      used: report.summaryChars,
      limit: STEP2_BUDGETS.summaryChars,
      exceeded: report.summaryChars > STEP2_BUDGETS.summaryChars,
    },
  ];
  for (const row of report.perRoleCounts) {
    const label = employmentLabel(payload, row.roleId);
    lines.push({
      key: `role:${row.roleId}`,
      label: label === null ? `Role ${row.roleId === "" ? "(unlinked)" : row.roleId}` : `${label.company} — ${label.role}`,
      used: row.bullets,
      limit: STEP2_BUDGETS.bulletsPerRole,
      exceeded: row.bullets > STEP2_BUDGETS.bulletsPerRole,
    });
  }
  lines.push({
    key: "total",
    label: "Total bullets",
    used: report.totalBullets,
    limit: STEP2_BUDGETS.totalBullets,
    exceeded: report.totalBullets > STEP2_BUDGETS.totalBullets,
  });
  return {
    lines,
    totalBullets: report.totalBullets,
    summaryChars: report.summaryChars,
    exceeded: report.exceeded,
  };
}

/** Index verdicts by segment id (`summary` or `op:<operationId>`). */
export function indexVerdicts(
  validation: Step2ValidationV1 | null,
): Map<string, Step2SegmentVerdict> {
  const indexed = new Map<string, Step2SegmentVerdict>();
  for (const segment of validation?.segments ?? []) {
    indexed.set(segment.segmentId, segment);
  }
  return indexed;
}

/** Parse a server `draft.operations[N]...` field path to its op index. */
export function operationIndexFromField(field: string | undefined): number | null {
  if (field === undefined) {
    return null;
  }
  const match = /^draft\.operations\[(\d+)\]/.exec(field);
  if (match === null) {
    return null;
  }
  const index = Number(match[1]);
  return Number.isInteger(index) ? index : null;
}

/**
 * Version-normalized segment state for badges and Generate
 * gating. v1 segments block on `needs-evidence`; v2 segments
 * carry server-derived provenance and block only on structural
 * failure — user edits never block for evidence reasons.
 */
export interface EditorSegmentState {
  segmentId: string;
  kind: "summary" | "bullet";
  blocked: boolean;
  blockReason: string | null;
  badge: string;
  title: string;
  provenance: Step2Provenance | null;
}

export function editorSegmentFromV1(segment: Step2SegmentVerdict): EditorSegmentState {
  const blocked = segment.verdict !== "supported";
  if (!blocked) {
    const count = segment.factIds.length;
    return {
      segmentId: segment.segmentId,
      kind: segment.kind,
      blocked: false,
      blockReason: null,
      badge: `Supported${count > 0 ? ` · ${count} fact${count === 1 ? "" : "s"}` : ""}`,
      title: `Match: ${segment.match}; facts: ${segment.factIds.join(", ") || "none"}`,
      provenance: null,
    };
  }
  return {
    segmentId: segment.segmentId,
    kind: segment.kind,
    blocked: true,
    blockReason: segment.reason,
    badge: "Needs evidence",
    title: segment.reason ?? "No supporting evidence found",
    provenance: null,
  };
}

export function editorSegmentFromV2(
  segment: Step2ValidationV2["segments"][number],
): EditorSegmentState {
  const blocked = !segment.structural.ok;
  return {
    segmentId: segment.segmentId,
    kind: segment.kind,
    blocked,
    blockReason: blocked ? segment.structural.reason : null,
    badge: PROVENANCE_REVIEW_LABELS[segment.provenance],
    title: blocked
      ? `Structural: ${segment.structural.reason ?? "invalid"} · provenance ${segment.provenance}`
      : `Provenance: ${segment.provenance}; anchors are context, not a verification claim`,
    provenance: segment.provenance,
  };
}

/** Index normalized v1 or v2 segments by segment id. */
export function indexEditorSegments(
  validation: Step2ValidationV1 | Step2ValidationV2 | null,
): Map<string, EditorSegmentState> {
  const indexed = new Map<string, EditorSegmentState>();
  if (validation === null) {
    return indexed;
  }
  if (validation.schemaVersion === "step2-validation/v2") {
    for (const segment of validation.segments) {
      indexed.set(segment.segmentId, editorSegmentFromV2(segment));
    }
    return indexed;
  }
  for (const segment of validation.segments) {
    indexed.set(segment.segmentId, editorSegmentFromV1(segment));
  }
  return indexed;
}
