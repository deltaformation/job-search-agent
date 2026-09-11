import { ReasonCode, ScrapeState } from "./enums";

/**
 * Scrape lifecycle for one job. Attempts are recorded separately and are
 * append-only; this machine rules only on the job-level `scrape_state`.
 * `FAILED`/`BLOCKED` outcomes require a reason code; retries requeue to
 * `QUEUED`. There is no re-scrape out of `SUCCEEDED` in MVP.
 */

export const SCRAPE_TRANSITIONS: Readonly<
  Record<ScrapeState, readonly ScrapeState[]>
> = {
  QUEUED: ["RUNNING"],
  RUNNING: ["SUCCEEDED", "FAILED", "BLOCKED"],
  SUCCEEDED: [],
  FAILED: ["QUEUED"],
  BLOCKED: ["QUEUED"],
};

export type ScrapeTransitionResult =
  | { ok: true; from: ScrapeState; to: ScrapeState }
  | {
      ok: false;
      error: "forbidden" | "reason-required";
      from: ScrapeState;
      to: ScrapeState;
      detail: string;
    };

export function planScrapeTransition(
  from: ScrapeState,
  input: { to: ScrapeState; reasonCode?: ReasonCode },
): ScrapeTransitionResult {
  const { to } = input;
  if (!SCRAPE_TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      error: "forbidden",
      from,
      to,
      detail: `scrape cannot move from ${from} to ${to}`,
    };
  }
  if ((to === "FAILED" || to === "BLOCKED") && input.reasonCode === undefined) {
    return {
      ok: false,
      error: "reason-required",
      from,
      to,
      detail: `scrape ${to} requires a reason code`,
    };
  }
  return { ok: true, from, to };
}

export function isTerminalScrapeState(state: ScrapeState): boolean {
  return state === "SUCCEEDED";
}
