import { Badge } from "@/components/ui/badge";

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
  const text = INTAKE_LABELS[outcome] ?? outcome;
  const variant =
    outcome === "ENQUEUED"
      ? "info"
      : outcome === "INVALID"
      ? "destructive"
      : outcome === "DUPLICATE"
      ? "secondary"
      : outcome === "BLOCKED"
      ? "warning"
      : "outline";

  return (
    <Badge variant={variant} className="text-xs font-medium">
      {text}
    </Badge>
  );
}

export function WorkStateLabel({ state }: { state: string }) {
  const text = WORK_LABELS[state] ?? state;
  const variant =
    state === "SUCCEEDED"
      ? "success"
      : state === "RUNNING"
      ? "warning"
      : state === "FAILED"
      ? "destructive"
      : state === "QUEUED"
      ? "info"
      : "outline";

  return (
    <Badge variant={variant} className="text-xs font-medium">
      {text}
    </Badge>
  );
}

const PREP_LABELS: Readonly<Record<string, string>> = {
  ABSENT: "Not prepared",
  PENDING: "Pending",
  QUEUED: "Queued",
  RUNNING: "Preparing",
  SUCCEEDED: "Plan ready",
  FAILED: "Failed",
};

/** Step 2 preparation state (S2-C batch diagnostics). Words, never color alone. */
export function PrepStateLabel({ state }: { state: string }) {
  const text = PREP_LABELS[state] ?? state;
  const variant =
    state === "SUCCEEDED"
      ? "success"
      : state === "RUNNING"
        ? "warning"
        : state === "FAILED"
          ? "destructive"
          : state === "QUEUED" || state === "PENDING"
            ? "info"
            : "outline";

  return (
    <Badge variant={variant} className="text-xs font-medium">
      {text}
    </Badge>
  );
}
