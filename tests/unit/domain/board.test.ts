// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  checkRowVersion,
  isOrdinaryBoardMove,
  planBoardMove,
  BoardMoveCommand,
} from "../../../src/domain";

const APPLIED_AT = "2026-09-11T12:00:00.000Z";

describe("board state machine", () => {
  it("accepts every ordinary edge", () => {
    const cases = [
      { from: "NEW", to: "REJECTED" },
      { from: "TAILORED", to: "REJECTED" },
      { from: "APPLIED", to: "INTERVIEWED" },
      { from: "APPLIED", to: "REJECTED" },
      { from: "INTERVIEWED", to: "REJECTED" },
    ] as const;
    for (const { from, to } of cases) {
      expect(isOrdinaryBoardMove(from, to)).toBe(true);
      const result = planBoardMove(
        { status: from, rowVersion: 4 },
        { kind: "move", to, observedRowVersion: 4 },
      );
      expect(result).toEqual({
        ok: true,
        from,
        to,
        newRowVersion: 5,
        viaCorrection: false,
      });
    }
  });

  it("moves TAILORED to APPLIED only with an appliedAt timestamp", () => {
    const ok = planBoardMove(
      { status: "TAILORED", rowVersion: 1 },
      { kind: "move", to: "APPLIED", observedRowVersion: 1, appliedAt: APPLIED_AT },
    );
    expect(ok.ok).toBe(true);
    const missing = planBoardMove(
      { status: "TAILORED", rowVersion: 1 },
      { kind: "move", to: "APPLIED", observedRowVersion: 1 },
    );
    expect(missing).toMatchObject({ ok: false, error: "application-data-required" });
  });

  it("enters TAILORED only through the approval transaction", () => {
    const move = planBoardMove(
      { status: "NEW", rowVersion: 1 },
      { kind: "move", to: "TAILORED", observedRowVersion: 1 },
    );
    expect(move).toMatchObject({ ok: false, error: "approval-required" });

    const correction = planBoardMove(
      { status: "NEW", rowVersion: 1 },
      { kind: "correction", to: "TAILORED", observedRowVersion: 1, note: "trust me" },
    );
    expect(correction).toMatchObject({ ok: false, error: "approval-required" });

    const approval = planBoardMove(
      { status: "NEW", rowVersion: 1 },
      { kind: "approval", to: "TAILORED", observedRowVersion: 1 },
    );
    expect(approval).toEqual({
      ok: true,
      from: "NEW",
      to: "TAILORED",
      newRowVersion: 2,
      viaCorrection: false,
    });

    const wrongFrom = planBoardMove(
      { status: "TAILORED", rowVersion: 2 },
      { kind: "approval", to: "TAILORED", observedRowVersion: 2 },
    );
    expect(wrongFrom).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("routes off-graph moves to explicit corrections", () => {
    const direct = planBoardMove(
      { status: "NEW", rowVersion: 1 },
      { kind: "move", to: "APPLIED", observedRowVersion: 1, appliedAt: APPLIED_AT },
    );
    expect(direct).toMatchObject({ ok: false, error: "correction-required" });

    const corrected = planBoardMove(
      { status: "NEW", rowVersion: 1 },
      {
        kind: "correction",
        to: "APPLIED",
        observedRowVersion: 1,
        note: "Applied before tracking started.",
        appliedAt: APPLIED_AT,
      },
    );
    expect(corrected).toMatchObject({ ok: true, viaCorrection: true });

    const reopen = planBoardMove(
      { status: "REJECTED", rowVersion: 3 },
      { kind: "correction", to: "NEW", observedRowVersion: 3, note: "Reopened: new contact." },
    );
    expect(reopen).toMatchObject({ ok: true, from: "REJECTED", to: "NEW" });
  });

  it("rejects stale clients, no-op moves, and data-less corrections", () => {
    const stale = planBoardMove(
      { status: "NEW", rowVersion: 2 },
      { kind: "move", to: "REJECTED", observedRowVersion: 1 },
    );
    expect(stale).toMatchObject({ ok: false, error: "conflict" });

    const noop = planBoardMove(
      { status: "NEW", rowVersion: 1 },
      { kind: "move", to: "NEW", observedRowVersion: 1 },
    );
    expect(noop).toMatchObject({ ok: false, error: "forbidden" });

    const correctionNoop = planBoardMove(
      { status: "NEW", rowVersion: 1 },
      { kind: "correction", to: "NEW", observedRowVersion: 1, note: "x" },
    );
    expect(correctionNoop).toMatchObject({ ok: false, error: "forbidden" });

    const appliedNoData = planBoardMove(
      { status: "REJECTED", rowVersion: 1 },
      { kind: "correction", to: "APPLIED", observedRowVersion: 1, note: "x" },
    );
    expect(appliedNoData).toMatchObject({
      ok: false,
      error: "application-data-required",
    });
  });

  it("validates command shape strictly", () => {
    expect(
      BoardMoveCommand.safeParse({
        kind: "move",
        to: "REJECTED",
        observedRowVersion: 1,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      BoardMoveCommand.safeParse({
        kind: "teleport",
        to: "NEW",
        observedRowVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      BoardMoveCommand.safeParse({
        kind: "correction",
        to: "NEW",
        observedRowVersion: 1,
        note: "   ",
      }).success,
    ).toBe(false);
    expect(
      BoardMoveCommand.safeParse({
        kind: "move",
        to: "APPLIED",
        observedRowVersion: 1,
        appliedAt: "yesterday",
      }).success,
    ).toBe(false);
    expect(
      BoardMoveCommand.safeParse({
        kind: "move",
        to: "REJECTED",
        observedRowVersion: 0,
      }).success,
    ).toBe(false);
  });

  it("checks row versions standalone for non-move CAS writes", () => {
    expect(checkRowVersion(3, 3)).toEqual({ ok: true });
    expect(checkRowVersion(3, 2)).toEqual({
      ok: false,
      currentRowVersion: 3,
      observedRowVersion: 2,
    });
  });
});
