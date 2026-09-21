/**
 * Human copy for tailoring states. The attempt's error detail (rate
 * limit, auth, timeout, render check) is the specific diagnosis; these
 * lines explain the state around it. Every FAILED/BLOCKED code has an
 * entry so the drawer never shows a bare constant.
 */

const REASON_COPY: Record<string, string> = {
  PROVIDER_UNAVAILABLE:
    "The AI provider did not return a usable proposal. Check the detail below, then retry.",
  TIMEOUT: "The AI provider did not respond in time. Retry when the network is stable.",
  EXTRACTION_INCOMPLETE:
    "There is no extracted job description to tailor against. Re-scrape the posting first.",
  STALE_INPUT: "The snapshots moved under this run. Retry to bind the current inputs.",
  RENDER_FAILED:
    "The resume draft was built but a document check failed (page budget or cross-format mismatch). Retry to rebuild.",
  PROFILE_REQUIRED: "No approved candidate profile exists yet. Approve a profile first.",
  VERSION_DECLINED:
    "You declined this version. It is frozen; adjust guidance and generate a new version when ready.",
};

export function tailoringReasonCopy(reasonCode: string | null): string {
  if (reasonCode === null) {
    return "The tailoring run failed without a recorded reason.";
  }
  return REASON_COPY[reasonCode] ?? `The tailoring run failed (${reasonCode}).`;
}

export function tailoringStateCopy(state: string): string {
  if (state === "RUNNING") {
    return "Tailoring in progress";
  }
  if (state === "PENDING") {
    return "Queued for tailoring";
  }
  if (state === "READY") {
    return "Ready to generate";
  }
  if (state === "DECLINED") {
    return "Version declined";
  }
  if (state === "REVISION_REQUESTED") {
    return "Revision run queued";
  }
  if (state === "FAILED" || state === "BLOCKED") {
    return "Tailoring failed";
  }
  return state.charAt(0) + state.slice(1).toLowerCase().replace(/_/g, " ");
}
