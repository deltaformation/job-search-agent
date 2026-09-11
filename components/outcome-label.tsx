/** Human-readable status labels. States are always words, never
 * color alone, so progress stays legible without color perception. */

const INTAKE_LABELS: Readonly<Record<string, string>> = {
  PENDING: "Pending",
  ENQUEUED: "Queued",
  INVALID: "Invalid",
  DUPLICATE: "Duplicate",
  BLOCKED: "Blocked",
};

const WORK_LABELS: Readonly<Record<string, string>> = {
  QUEUED: "Queued",
  RUNNING: "Running",
  SUCCEEDED: "Done",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export function OutcomeLabel({ outcome }: { outcome: string }) {
  return <span>{INTAKE_LABELS[outcome] ?? outcome}</span>;
}

export function WorkStateLabel({ state }: { state: string }) {
  return <span>{WORK_LABELS[state] ?? state}</span>;
}
