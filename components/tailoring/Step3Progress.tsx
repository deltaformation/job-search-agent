"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  RefreshCw,
  Server,
  Sparkles,
  User,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { openSettings } from "@/components/settings/profiles";
import {
  ProgressReply,
  TAILORING_RETRY_SCHEMA_VERSION,
  type ProgressReply as ProgressReplyType,
  type TailoringFailure as TailoringFailureType,
  type TailoringStage,
} from "@/src/domain/tailoringWorkspace";
import type { StepNumber } from "./StepIndicator";

/**
 * Step 3 generation progress (WO-1.3-F): persisted-attempt elapsed
 * time, real worker stage boundaries, lease-aware liveness, typed
 * safe failures, and attempt-specific retry. Polling and timers
 * never mutate: every read is a GET, and the browser clock only
 * interpolates between server timestamps.
 */

const POLL_VISIBLE_MS = 2000;
const POLL_HIDDEN_MS = 10000;
const UNAVAILABLE_FAILURES = 2;
const PROVIDER_WAITING_MS = 30000;
const FUTURE_START_TOLERANCE_MS = 1000;

export const STAGE_ORDER: TailoringStage[] = [
  "PREPARING_INPUTS",
  "WAITING_FOR_PROVIDER",
  "VALIDATING_PROPOSAL",
  "RENDERING_ARTIFACTS",
  "PUBLISHING_RESULT",
];

export const STAGE_COPY: Record<TailoringStage, { label: string; description: string }> = {
  PREPARING_INPUTS: {
    label: "Checking inputs",
    description: "Checking your profile and selected focus.",
  },
  WAITING_FOR_PROVIDER: {
    label: "Waiting for AI response",
    description: "Waiting for the draft.",
  },
  VALIDATING_PROPOSAL: {
    label: "Validating proposed claims",
    description: "Checking claims against your experience.",
  },
  RENDERING_ARTIFACTS: {
    label: "Preparing documents",
    description: "Formatting your resume.",
  },
  PUBLISHING_RESULT: {
    label: "Saving results",
    description: "Publishing your tailored resume.",
  },
};

export const CACHED_PROVIDER_DESCRIPTION = "Loading the saved proposal from the previous attempt.";

export const FAILURE_COPY: Record<
  TailoringFailureType["code"],
  { title: string; body: string }
> = {
  INPUT_STALE: {
    title: "The inputs changed before generation finished.",
    body: "Start a new run from Step 2 with the current job data.",
  },
  PROFILE_UNAVAILABLE: {
    title: "The candidate profile is no longer available.",
    body: "Restore the profile, then start a new run.",
  },
  CONFIGURATION: {
    title: "The AI provider isn't configured.",
    body: "Open Settings, repair the provider setup, then retry the same inputs.",
  },
  AUTHENTICATION: {
    title: "The AI provider rejected the request.",
    body: "Check the provider key in Settings, then retry the same inputs.",
  },
  RATE_LIMIT: {
    title: "The AI provider is rate-limited.",
    body: "Wait for quota, then retry the same inputs.",
  },
  NETWORK: {
    title: "The AI request failed on the network.",
    body: "Check connectivity from this machine, then retry.",
  },
  PROVIDER_TIMEOUT: {
    title: "The AI provider took too long to respond.",
    body: "Try again — your focus choices are unchanged.",
  },
  LOCAL_LAUNCH: {
    title: "The app couldn't start the AI connection process.",
    body: "Check Settings, then retry. Retry may fail again until setup is repaired.",
  },
  INVALID_RESPONSE: {
    title: "The AI provider returned an unusable proposal.",
    body: "Try again — your focus choices are unchanged.",
  },
  CLAIM_VALIDATION: {
    title: "The proposal couldn't be backed by your experience.",
    body: "Adjust the focus in Step 2 and start a new run.",
  },
  RENDER_FAILED: {
    title: "The resume documents couldn't be rendered.",
    body: "Try again — your focus choices are unchanged.",
  },
  PUBLISH_FAILED: {
    title: "The results couldn't be saved.",
    body: "Try again — your focus choices are unchanged.",
  },
  LEASE_LOST: {
    title: "The worker lost contact mid-run.",
    body: "Wait for recovery; retry if the run doesn't resume on its own.",
  },
  INTERNAL: {
    title: "Something unexpected stopped generation.",
    body: "Retry; report it if the failure repeats.",
  },
};

export interface ElapsedInput {
  startedAt: string | null;
  finishedAt: string | null;
  estimatedServerNowMs: number | null;
}

/**
 * Displayed whole seconds for the current attempt (§6): floor of the
 * non-negative server-time delta. Invalid, missing, or more-than-a-
 * second future starts show no numeric duration — never NaN,
 * negatives, or fabricated history.
 */
export function elapsedSecondsFor(input: ElapsedInput): number | null {
  if (input.startedAt === null) {
    return null;
  }
  const startMs = Date.parse(input.startedAt);
  if (!Number.isFinite(startMs)) {
    return null;
  }
  let endMs: number | null = null;
  if (input.finishedAt !== null) {
    const finishedMs = Date.parse(input.finishedAt);
    if (!Number.isFinite(finishedMs)) {
      return null;
    }
    endMs = finishedMs;
  } else if (input.estimatedServerNowMs !== null && Number.isFinite(input.estimatedServerNowMs)) {
    endMs = input.estimatedServerNowMs;
  }
  if (endMs === null) {
    return null;
  }
  if (startMs > endMs + FUTURE_START_TOLERANCE_MS) {
    return null;
  }
  return Math.floor(Math.max(0, endMs - startMs) / 1000);
}

interface Step3ProgressProps {
  jobId: string;
  requestId: string | null;
  onNavigateStep: (step: StepNumber) => void;
}

interface JobDetailResponse {
  job?: { rowVersion?: unknown };
}

function errorMessageOf(json: unknown, fallback: string): string {
  if (typeof json === "object" && json !== null) {
    const error = (json as Record<string, unknown>)["error"];
    if (typeof error === "object" && error !== null) {
      const message = (error as Record<string, unknown>)["message"];
      if (typeof message === "string" && message !== "") {
        return message;
      }
      const code = (error as Record<string, unknown>)["code"];
      if (typeof code === "string" && code !== "") {
        return `Request failed (${code}).`;
      }
    }
  }
  return fallback;
}

export default function Step3Progress({ jobId, requestId, onNavigateStep }: Step3ProgressProps) {
  const [snapshot, setSnapshot] = useState<ProgressReplyType | null>(null);
  const [pollFailures, setPollFailures] = useState(0);
  const [clockSync, setClockSync] = useState<{ serverMs: number; perfMs: number } | null>(null);
  const [round, setRound] = useState(0);
  const [nowPerf, setNowPerf] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const progressUrl =
    requestId === null
      ? null
      : `/api/jobs/${jobId}/tailoring/generations/${requestId}`;

  // Poll loop: 2s visible / 10s hidden; stops at terminal states and
  // restarts on retry/refresh. Failures retain the last snapshot.
  useEffect(() => {
    if (progressUrl === null) {
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (!live) {
        return;
      }
      try {
        const response = await fetch(progressUrl);
        if (!response.ok) {
          throw new Error(`progress GET ${response.status}`);
        }
        const parsed = ProgressReply.safeParse((await response.json()) as unknown);
        if (!parsed.success) {
          throw new Error("progress reply failed validation");
        }
        if (!live) {
          return;
        }
        setSnapshot(parsed.data);
        setPollFailures(0);
        setClockSync({ serverMs: Date.parse(parsed.data.serverNow), perfMs: performance.now() });
        if (parsed.data.state === "SUCCEEDED" || parsed.data.state === "FAILED") {
          return;
        }
      } catch {
        if (live) {
          setPollFailures((count) => count + 1);
        }
      }
      if (live) {
        timer = setTimeout(poll, document.visibilityState === "hidden" ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
      }
    };
    void poll();
    const onVisibility = () => {
      // Visible again: repoll immediately so the clock resyncs and
      // catches up instead of counting throttled ticks.
      if (document.visibilityState === "visible" && live) {
        if (timer !== null) {
          clearTimeout(timer);
        }
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      live = false;
      if (timer !== null) {
        clearTimeout(timer);
      }
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [progressUrl, round]);

  const terminal = snapshot?.state === "SUCCEEDED" || snapshot?.state === "FAILED";

  // Display ticker: recompute from stable server timestamps; never
  // accumulates interval ticks and stops at terminal states.
  useEffect(() => {
    if (progressUrl === null || terminal) {
      return;
    }
    const timer = setInterval(() => setNowPerf(performance.now()), 500);
    return () => clearInterval(timer);
  }, [progressUrl, terminal]);

  const estimatedNowMs =
    clockSync === null || !Number.isFinite(clockSync.serverMs) || nowPerf === null
      ? null
      : clockSync.serverMs + (nowPerf - clockSync.perfMs);

  const latestAttemptId = snapshot?.attemptId ?? null;
  const handleRetry = useCallback(async () => {
    if (requestId === null || latestAttemptId === null) {
      return;
    }
    const observedAttemptId = latestAttemptId;
    setRetrying(true);
    setRetryError(null);
    try {
      const jobResponse = await fetch(`/api/jobs/${jobId}`);
      if (!jobResponse.ok) {
        throw new Error("job refresh failed");
      }
      const rowVersion = ((await jobResponse.json()) as JobDetailResponse).job?.rowVersion;
      if (typeof rowVersion !== "number" || !Number.isInteger(rowVersion) || rowVersion <= 0) {
        throw new Error("job refresh failed");
      }
      const response = await fetch(
        `/api/jobs/${jobId}/tailoring/generations/${requestId}/retry`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            schemaVersion: TAILORING_RETRY_SCHEMA_VERSION,
            observedAttemptId,
            observedRowVersion: rowVersion,
          }),
        },
      );
      let json: unknown = null;
      try {
        json = (await response.json()) as unknown;
      } catch {
        json = null;
      }
      if (!mountedRef.current) {
        return;
      }
      if (response.status === 202 || response.status === 200) {
        setPollFailures(0);
        setRound((value) => value + 1);
      } else {
        setRetryError(errorMessageOf(json, "Retry was rejected. Nothing was requeued."));
        setRound((value) => value + 1);
      }
    } catch {
      if (mountedRef.current) {
        setRetryError("Couldn't reach the server. Nothing was requeued — it is safe to retry again.");
      }
    } finally {
      if (mountedRef.current) {
        setRetrying(false);
      }
    }
  }, [jobId, requestId, latestAttemptId]);

  const handleCopyDiagnostics = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      if (mountedRef.current) {
        setCopied(true);
        setTimeout(() => {
          if (mountedRef.current) {
            setCopied(false);
          }
        }, 2000);
      }
    } catch {
      if (mountedRef.current) {
        setCopied(false);
      }
    }
  }, []);

  if (requestId === null) {
    return (
      <div className="rounded-xl border border-border/70 bg-card p-6">
        <div className="flex items-center gap-3">
          <div className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Sparkles className="size-4" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">No active generation</h3>
            <p className="text-xs text-muted-foreground">
              Submit a tailoring request from Step 2 to begin generation.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const events = snapshot?.events ?? [];
  const currentEvent = events.length === 0 ? null : events[events.length - 1];
  const currentStageIndex =
    currentEvent === null ? -1 : STAGE_ORDER.indexOf(currentEvent.stage);
  const elapsed = snapshot
    ? elapsedSecondsFor({
        startedAt: snapshot.state === "QUEUED" ? null : snapshot.startedAt,
        finishedAt: snapshot.finishedAt,
        estimatedServerNowMs: estimatedNowMs,
      })
    : null;
  const statusUnavailable = pollFailures >= UNAVAILABLE_FAILURES;
  const leaseExpired =
    snapshot?.state === "RUNNING" &&
    snapshot.leaseExpiresAt !== null &&
    estimatedNowMs !== null &&
    estimatedNowMs >= Date.parse(snapshot.leaseExpiresAt);
  const providerWaiting =
    snapshot?.state === "RUNNING" &&
    currentEvent?.stage === "WAITING_FOR_PROVIDER" &&
    estimatedNowMs !== null &&
    Number.isFinite(Date.parse(currentEvent.recordedAt)) &&
    estimatedNowMs - Date.parse(currentEvent.recordedAt) >= PROVIDER_WAITING_MS;
  const failure = snapshot?.state === "FAILED" ? snapshot.failure : null;
  const transientFailure =
    snapshot?.state === "QUEUED" && snapshot.failure !== null ? snapshot.failure : null;
  const stageDescription =
    currentEvent?.stage === "WAITING_FOR_PROVIDER" && currentEvent.source === "cached"
      ? CACHED_PROVIDER_DESCRIPTION
      : currentEvent === null
        ? null
        : STAGE_COPY[currentEvent.stage].description;

  // Diagnostics carry allowlisted fields only — codes, stages,
  // timestamps, and references. No raw errors, paths, or payloads.
  const diagnosticsText =
    failure === null || snapshot === null
      ? null
      : [
          `code: ${failure.code}`,
          `stage: ${failure.stage ?? "unknown"}`,
          `occurred at: ${failure.occurredAt}`,
          `request: ${snapshot.requestId}`,
          `attempt: ${snapshot.attemptId ?? "unknown"}`,
          ...(failure.launchSubcode === null ? [] : [`launch: ${failure.launchSubcode}`]),
        ].join("\n");

  const announce = snapshot
    ? snapshot.state === "RUNNING"
      ? currentEvent === null
        ? "Generation running."
        : `Generation stage ${currentEvent.seq} of 5: ${STAGE_COPY[currentEvent.stage].label}`
      : snapshot.state === "QUEUED"
        ? "Generation queued, waiting for a worker."
        : snapshot.state === "SUCCEEDED"
          ? "Generation complete."
          : failure === null
            ? "Generation failed."
            : `Generation failed: ${FAILURE_COPY[failure.code].title}`
    : "Loading generation status.";

  return (
    <div className="space-y-4">
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>

      {statusUnavailable && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-foreground">
          <span className="font-semibold">Status unavailable</span>
          <span className="text-muted-foreground">
            {" "}
            — couldn&apos;t reach the server. Showing the last known stage.
          </span>
        </div>
      )}

      <section aria-label="Generation status" className="rounded-xl border border-border/70 bg-card p-6">
        {snapshot === null ? (
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Sparkles className="size-4 animate-pulse" aria-hidden="true" />
            </div>
            <p className="text-xs text-muted-foreground">Loading generation status…</p>
          </div>
        ) : snapshot.state === "SUCCEEDED" ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex size-8 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
                <CheckCircle2 className="size-4" aria-hidden="true" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Resume ready for review</h3>
                <p className="text-xs text-muted-foreground">
                  {elapsed === null
                    ? "Generation finished."
                    : `Generation finished in ${elapsed}s.`}{" "}
                  No approval has been recorded.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 border-t border-border/50 pt-4">
              <Button
                type="button"
                onClick={() => onNavigateStep(4)}
                className="gap-1.5 text-xs font-semibold cursor-pointer"
              >
                <span>Review version</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onNavigateStep(2)}
                className="gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <ArrowLeft className="size-3.5" aria-hidden="true" />
                <span>Back to focus</span>
              </Button>
            </div>
          </div>
        ) : snapshot.state === "FAILED" && failure !== null ? (
          <div className="space-y-5">
            <div className="flex items-start gap-4">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400">
                <XCircle className="size-6" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <span className="text-xs font-semibold tracking-wide text-rose-600 dark:text-rose-400">
                  Generation failed
                </span>
                <h3 className="text-lg font-semibold text-foreground">
                  {FAILURE_COPY[failure.code].title}
                </h3>
                <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
                  {FAILURE_COPY[failure.code].body} No new resume was created.
                  {elapsed !== null ? ` The run lasted ${elapsed}s.` : ""}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-border/50 pt-4">
              {snapshot.retryAllowed && (
                <Button
                  type="button"
                  onClick={() => void handleRetry()}
                  disabled={retrying}
                  className="gap-2 font-semibold cursor-pointer"
                >
                  <RefreshCw
                    className={`size-4 ${retrying ? "animate-spin" : ""}`}
                    aria-hidden="true"
                  />
                  <span>{retrying ? "Retrying…" : "Retry generation"}</span>
                </Button>
              )}
              {(failure.action === "open_settings" || failure.code === "LOCAL_LAUNCH") && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => openSettings("ai")}
                  className="gap-2 text-xs cursor-pointer"
                >
                  <Server className="size-3.5" aria-hidden="true" />
                  <span>Check connection</span>
                </Button>
              )}
              {failure.action === "edit_profile" && (
                <a
                  href="/master-resume"
                  className="inline-flex items-center gap-2 rounded-lg border border-border/70 bg-card px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/40 transition-colors"
                >
                  <User className="size-3.5" aria-hidden="true" />
                  <span>Open candidate profile</span>
                </a>
              )}
              <Button
                type="button"
                variant="ghost"
                onClick={() => onNavigateStep(2)}
                className="gap-2 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <ArrowLeft className="size-3.5" aria-hidden="true" />
                <span>Back to focus</span>
              </Button>
            </div>

            {retryError !== null && (
              <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
                {retryError}
              </p>
            )}

            <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
              <button
                type="button"
                onClick={() => setDetailsOpen(!detailsOpen)}
                aria-expanded={detailsOpen}
                className="flex w-full items-center justify-between text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <span className="font-semibold">Error details</span>
                {detailsOpen ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
              </button>
              {detailsOpen && diagnosticsText !== null && (
                <div className="mt-2 space-y-2">
                  <pre className="overflow-x-auto rounded bg-background p-2.5 font-mono text-[11px] text-muted-foreground">
                    {diagnosticsText}
                  </pre>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleCopyDiagnostics(diagnosticsText)}
                    className="gap-1.5 text-xs cursor-pointer"
                  >
                    <Copy className="size-3.5" aria-hidden="true" />
                    <span>{copied ? "Copied" : "Copy diagnostics"}</span>
                  </Button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <div className="flex items-center gap-3">
                <div className="relative flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Sparkles className="size-5 animate-pulse" aria-hidden="true" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold tracking-wide text-primary">
                      {snapshot.state === "QUEUED" ? "Queued" : "Preparing your resume"}
                    </span>
                    {currentEvent !== null && (
                      <Badge variant="outline" className="text-[10px]">
                        Stage {currentEvent.seq} of 5
                      </Badge>
                    )}
                  </div>
                  <h3 className="text-base font-semibold text-foreground sm:text-lg">
                    {snapshot.state === "QUEUED"
                      ? "Waiting for a worker"
                      : currentEvent === null
                        ? "Starting…"
                        : STAGE_COPY[currentEvent.stage].label}
                  </h3>
                </div>
              </div>

              {snapshot.state === "RUNNING" && (
                <div className="flex items-center gap-2 self-start rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 sm:self-center">
                  <Clock className="size-4 text-muted-foreground" aria-hidden="true" />
                  <span
                    className="font-mono text-sm font-semibold tabular-nums text-foreground"
                    aria-hidden="true"
                  >
                    {elapsed === null ? "in progress" : `${elapsed}s elapsed`}
                  </span>
                  <span className="sr-only">
                    {elapsed === null ? "Generation in progress." : `Generation running, ${elapsed} seconds elapsed.`}
                  </span>
                </div>
              )}
            </div>

            {snapshot.state === "QUEUED" ? (
              <p className="rounded-lg border border-border/50 bg-muted/20 p-3.5 text-xs leading-relaxed text-muted-foreground sm:text-sm">
                Your request is queued. The run timer starts when a worker claims it.
                {transientFailure !== null && (
                  <>
                    {" "}
                    The previous attempt failed ({transientFailure.code}); the worker is
                    retrying automatically.
                  </>
                )}
              </p>
            ) : (
              stageDescription !== null && (
                <p className="rounded-lg border border-primary/20 bg-primary/5 p-3.5 text-xs leading-relaxed text-foreground sm:text-sm">
                  {stageDescription}
                </p>
              )
            )}

            {leaseExpired && (
              <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-foreground">
                <span className="font-semibold">Waiting for worker recovery</span>
                <span className="text-muted-foreground">
                  {" "}
                  — the worker stopped checking in. The run will resume or fail on its own;
                  this is not a failure yet.
                </span>
              </p>
            )}

            {providerWaiting && !leaseExpired && (
              <p className="rounded-lg border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground">
                Waiting for the AI response — a slow provider call is still running. Only an
                actual timeout ends the run.
              </p>
            )}

            {snapshot.state === "RUNNING" && (
              <div className="space-y-2" aria-hidden="true">
                <div className="grid grid-cols-5 gap-1.5 sm:gap-2">
                  {STAGE_ORDER.map((stage, index) => {
                    const isDone = index < currentStageIndex;
                    const isCurrent = index === currentStageIndex;
                    return (
                      <div key={stage} className="space-y-1.5">
                        <div
                          className={`h-2 rounded-full ${
                            isDone
                              ? "bg-emerald-600"
                              : isCurrent
                                ? "bg-primary animate-pulse"
                                : "bg-muted"
                          }`}
                        />
                        <p
                          className={`truncate text-[10px] sm:text-xs ${
                            isCurrent
                              ? "font-semibold text-primary"
                              : isDone
                                ? "font-medium text-foreground"
                                : "text-muted-foreground"
                          }`}
                        >
                          {STAGE_COPY[stage].label}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
