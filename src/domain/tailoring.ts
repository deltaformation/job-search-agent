import { ReasonCode, TailoringState } from "./enums";

/**
 * Tailoring lifecycle for one job. `BLOCKED` (missing profile or provider
 * configuration) and `FAILED` outcomes require a reason code; both retry
 * into `RUNNING`, as does `REVISION_REQUESTED` when a new revision run
 * starts. `APPROVED` is terminal: further work is a new resume version.
 */

export const TAILORING_TRANSITIONS: Readonly<
  Record<TailoringState, readonly TailoringState[]>
> = {
  PENDING: ["RUNNING", "BLOCKED"],
  BLOCKED: ["RUNNING"],
  RUNNING: ["AWAITING_REVIEW", "FAILED"],
  AWAITING_REVIEW: ["APPROVED", "REVISION_REQUESTED", "FAILED"],
  APPROVED: [],
  REVISION_REQUESTED: ["RUNNING"],
  FAILED: ["RUNNING"],
};

export type TailoringTransitionResult =
  | { ok: true; from: TailoringState; to: TailoringState }
  | {
      ok: false;
      error: "forbidden" | "reason-required";
      from: TailoringState;
      to: TailoringState;
      detail: string;
    };

export function planTailoringTransition(
  from: TailoringState,
  input: { to: TailoringState; reasonCode?: ReasonCode },
): TailoringTransitionResult {
  const { to } = input;
  if (!TAILORING_TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      error: "forbidden",
      from,
      to,
      detail: `tailoring cannot move from ${from} to ${to}`,
    };
  }
  if ((to === "FAILED" || to === "BLOCKED") && input.reasonCode === undefined) {
    return {
      ok: false,
      error: "reason-required",
      from,
      to,
      detail: `tailoring ${to} requires a reason code`,
    };
  }
  return { ok: true, from, to };
}
