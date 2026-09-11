import { z } from "zod";
import { BoardStatus } from "./enums";
import { IsoUtcDateTime, RequiredNote, RowVersion } from "./fields";

/**
 * Board state machine. Board state and worker state are separate: this module
 * rules only on the five Kanban columns.
 *
 * Ordinary moves follow a fixed graph. Anything outside the graph needs an
 * explicit correction carrying a human note — except entering `TAILORED`,
 * which only the approval transaction may perform, even as a correction.
 * Moves into `APPLIED` must carry the recorded `appliedAt` timestamp.
 * Every move is guarded by an optimistic `row_version` compare-and-swap.
 */

export const ORDINARY_BOARD_MOVES: Readonly<
  Record<BoardStatus, readonly BoardStatus[]>
> = {
  NEW: ["REJECTED"],
  TAILORED: ["APPLIED", "REJECTED"],
  APPLIED: ["INTERVIEWED", "REJECTED"],
  INTERVIEWED: ["REJECTED"],
  REJECTED: [],
};

export const BoardMoveCommand = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("move"),
      to: BoardStatus,
      observedRowVersion: RowVersion,
      appliedAt: IsoUtcDateTime.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("correction"),
      to: BoardStatus,
      observedRowVersion: RowVersion,
      note: RequiredNote,
      appliedAt: IsoUtcDateTime.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("approval"),
      to: z.literal("TAILORED"),
      observedRowVersion: RowVersion,
    })
    .strict(),
]);
export type BoardMoveCommand = z.infer<typeof BoardMoveCommand>;

export type BoardMoveError =
  | "conflict"
  | "forbidden"
  | "correction-required"
  | "approval-required"
  | "application-data-required";

export type BoardMoveResult =
  | {
      ok: true;
      from: BoardStatus;
      to: BoardStatus;
      newRowVersion: number;
      viaCorrection: boolean;
    }
  | {
      ok: false;
      error: BoardMoveError;
      from: BoardStatus;
      to: BoardStatus;
      detail: string;
    };

export function isOrdinaryBoardMove(
  from: BoardStatus,
  to: BoardStatus,
): boolean {
  return from !== to && ORDINARY_BOARD_MOVES[from].includes(to);
}

export function checkRowVersion(
  currentRowVersion: number,
  observedRowVersion: number,
):
  | { ok: true }
  | {
      ok: false;
      currentRowVersion: number;
      observedRowVersion: number;
    } {
  if (currentRowVersion !== observedRowVersion) {
    return { ok: false, currentRowVersion, observedRowVersion };
  }
  return { ok: true };
}

/**
 * Rule a board move without touching storage. Services call this inside
 * their compare-and-swap transaction; a rejection must commit nothing.
 */
export function planBoardMove(
  current: { status: BoardStatus; rowVersion: number },
  command: BoardMoveCommand,
): BoardMoveResult {
  const { status: from } = current;
  const { to } = command;

  const version = checkRowVersion(current.rowVersion, command.observedRowVersion);
  if (!version.ok) {
    return {
      ok: false,
      error: "conflict",
      from,
      to,
      detail: `stale client: observed row_version ${version.observedRowVersion}, current is ${version.currentRowVersion}`,
    };
  }

  if (to === from) {
    return {
      ok: false,
      error: "forbidden",
      from,
      to,
      detail: "not a status transition (rank-only reorder is a separate command)",
    };
  }

  if (command.kind === "approval") {
    if (from !== "NEW") {
      return {
        ok: false,
        error: "forbidden",
        from,
        to,
        detail: "approval moves only NEW jobs to TAILORED",
      };
    }
    return { ok: true, from, to, newRowVersion: current.rowVersion + 1, viaCorrection: false };
  }

  if (to === "TAILORED") {
    return {
      ok: false,
      error: "approval-required",
      from,
      to,
      detail: "only an exact-version human approval may enter TAILORED",
    };
  }

  if (command.kind === "correction") {
    if (to === "APPLIED" && command.appliedAt === undefined) {
      return {
        ok: false,
        error: "application-data-required",
        from,
        to,
        detail: "corrections into APPLIED must record appliedAt",
      };
    }
    return { ok: true, from, to, newRowVersion: current.rowVersion + 1, viaCorrection: true };
  }

  if (!isOrdinaryBoardMove(from, to)) {
    return {
      ok: false,
      error: "correction-required",
      from,
      to,
      detail: "outside the ordinary move graph: use an explicit correction with a note",
    };
  }
  if (to === "APPLIED" && command.appliedAt === undefined) {
    return {
      ok: false,
      error: "application-data-required",
      from,
      to,
      detail: "moves into APPLIED must record appliedAt",
    };
  }
  return { ok: true, from, to, newRowVersion: current.rowVersion + 1, viaCorrection: false };
}
