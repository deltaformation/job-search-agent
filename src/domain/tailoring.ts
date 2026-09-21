import { ReasonCode, TailoringState } from "./enums";

/**
 * Tailoring lifecycle for one job (WO-1.2-D explicit generation).
 * `READY` means an extracted JD is available with no run queued or
 * running; stored `PENDING` means an explicit request is queued
 * awaiting worker claim. `BLOCKED` (missing profile or provider
 * configuration) and `FAILED` outcomes require a reason code.
 * Explicit new-version commands move `AWAITING_REVIEW`, `APPROVED`,
 * `DECLINED`, `BLOCKED`, and `FAILED` back to queued `PENDING`;
 * a claim moves `PENDING` (or `REVISION_REQUESTED`) to `RUNNING`.
 */

export const TAILORING_TRANSITIONS: Readonly<
  Record<TailoringState, readonly TailoringState[]>
> = {
  PENDING: ["READY", "RUNNING", "BLOCKED", "FAILED"],
  READY: ["PENDING", "BLOCKED"],
  BLOCKED: ["PENDING"],
  RUNNING: ["AWAITING_REVIEW", "FAILED"],
  AWAITING_REVIEW: ["APPROVED", "REVISION_REQUESTED", "DECLINED", "FAILED", "PENDING"],
  APPROVED: ["PENDING"],
  REVISION_REQUESTED: ["RUNNING"],
  DECLINED: ["PENDING"],
  FAILED: ["PENDING"],
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
