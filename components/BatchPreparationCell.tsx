"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BatchItemView } from "@/src/server/queries";
import {
  STEP2_SCHEMA_VERSIONS,
  type PreparationStatusV1 as PreparationStatusV1Type,
} from "@/src/domain/step2";
import { parseTailoringError } from "./tailoring/focusDraft";
import { PrepStateLabel } from "./outcome-label";

function stageLabel(stage: string): string {
  switch (stage) {
    case "LOADING_INPUTS":
      return "Loading inputs";
    case "WAITING_FOR_PROVIDER":
      return "Waiting for provider";
    case "VALIDATING_PROPOSAL":
      return "Validating proposal";
    case "STORING_PLAN":
      return "Storing plan";
    case "PUBLISHING_PLAN":
      return "Publishing plan";
    default:
      return stage;
  }
}

function failureHint(action: string | undefined): string | null {
  switch (action) {
    case "edit_profile":
      return "Resolve it in Settings, then retry.";
    case "open_settings":
      return "Open Settings to configure the provider, then retry.";
    case "retry":
      return "Retry when ready.";
    case "wait":
      return "Wait a moment, then retry.";
    case "edit_focus":
      return "Adjust the Step 2 draft, then retry.";
    default:
      return null;
  }
}

/**
 * Per-line Step 2 preparation diagnostics (WO-1.3-S2-C). The batch
 * row already carries the preparation snapshot; this cell renders
 * it, fetches full stage/failure detail on demand, runs explicit
 * retries, and links both directions to the Step 2 editor. It never
 * fetches on mount and never shows provider internals — failure
 * codes plus the recovery action only.
 */
export default function BatchPreparationCell({
  item,
  onChanged,
}: {
  item: BatchItemView;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<PreparationStatusV1Type | null>(null);
  const [detailOpen, setDetailOpen] = useState<boolean>(false);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [retrying, setRetrying] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);

  const jobId = item.jobId ?? item.preparation?.jobId ?? null;
  const prep = item.preparation ?? null;

  if (prep === null && jobId === null) {
    return <span className="text-muted-foreground">—</span>;
  }

  const toggleDetail = async (): Promise<void> => {
    if (jobId === null) {
      return;
    }
    if (detailOpen) {
      setDetailOpen(false);
      return;
    }
    setDetailOpen(true);
    if (detail !== null) {
      return;
    }
    setDetailLoading(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/tailoring/preparation`);
      if (!response.ok) {
        const parsed = await parseTailoringError(response);
        setMessage(parsed.message);
        return;
      }
      const body = (await response.json()) as { preparation?: PreparationStatusV1Type };
      if (body.preparation === undefined) {
        setMessage("The preparation reply is unreadable.");
        return;
      }
      setDetail(body.preparation);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailLoading(false);
    }
  };

  const retry = async (): Promise<void> => {
    if (jobId === null) {
      return;
    }
    setRetrying(true);
    setMessage(null);
    try {
      const prepResponse = await fetch(`/api/jobs/${jobId}/tailoring/preparation`);
      if (!prepResponse.ok) {
        const parsed = await parseTailoringError(prepResponse);
        setMessage(parsed.message);
        return;
      }
      const prepBody = (await prepResponse.json()) as { preparation?: PreparationStatusV1Type };
      const attemptId = prepBody.preparation?.attemptId;
      if (attemptId === null || attemptId === undefined) {
        setMessage("No failed attempt is available to retry.");
        return;
      }
      const jobResponse = await fetch(`/api/jobs/${jobId}`);
      if (!jobResponse.ok) {
        setMessage(`The job cannot be read (${jobResponse.status}).`);
        return;
      }
      const jobBody = (await jobResponse.json()) as { job?: { rowVersion?: unknown } };
      if (typeof jobBody.job?.rowVersion !== "number") {
        setMessage("The job reply is unreadable.");
        return;
      }
      const retryResponse = await fetch(`/api/jobs/${jobId}/tailoring/preparation/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: STEP2_SCHEMA_VERSIONS.prepareRetry,
          observedAttemptId: attemptId,
          observedRowVersion: jobBody.job.rowVersion,
        }),
      });
      if (!retryResponse.ok) {
        const parsed = await parseTailoringError(retryResponse);
        setMessage(parsed.message);
        return;
      }
      setDetail(null);
      onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      {prep === null ? (
        <span className="text-muted-foreground">Not prepared</span>
      ) : (
        <>
          <div className="flex items-center gap-1.5">
            <PrepStateLabel state={prep.state} />
          </div>
          {prep.state === "FAILED" && prep.failureCode !== null && (
            <span className="font-mono text-[11px] text-muted-foreground">{prep.failureCode}</span>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {jobId !== null && (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary underline hover:text-primary/80"
            onClick={() => void toggleDetail()}
            aria-expanded={detailOpen}
          >
            <span>{detailOpen ? "hide" : "details"}</span>
            <ArrowRight className="h-2.5 w-2.5" />
          </button>
        )}
        {prep !== null && prep.state === "FAILED" && prep.retryAllowed && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={retrying}
            onClick={() => void retry()}
          >
            {retrying ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
            )}
            <span className="ml-1">Retry</span>
          </Button>
        )}
        {prep !== null && prep.state === "FAILED" && !prep.retryAllowed && (
          <span className="text-[11px] text-muted-foreground">cannot retry</span>
        )}
        {jobId !== null && (
          <Link
            href={`/jobs/${jobId}/tailor?step=2`}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary underline hover:text-primary/80"
          >
            <span>Step 2</span>
            <ArrowRight className="h-2.5 w-2.5" />
          </Link>
        )}
      </div>
      {detailOpen && jobId !== null && (
        <div className="text-[11px] text-muted-foreground">
          {detailLoading && <span>Loading detail…</span>}
          {!detailLoading && detail !== null && (
            <div className="space-y-1">
              {detail.events.length > 0 && (
                <ol className="list-decimal space-y-0.5 pl-4">
                  {detail.events.map((event) => (
                    <li key={event.seq}>
                      {stageLabel(event.stage)} ({event.source === "cached" ? "recovered" : "live"})
                    </li>
                  ))}
                </ol>
              )}
              {detail.failure !== null && (
                <p>
                  {detail.failure.code}. {failureHint(detail.failure.action) ?? ""}
                  {detail.failure.retryAfterSeconds !== null && detail.failure.retryAfterSeconds > 0 && (
                    <span> Retry in {detail.failure.retryAfterSeconds} s.</span>
                  )}
                </p>
              )}
              {detail.state === "SUCCEEDED" && detail.acceptedPlanId !== null && (
                <p>Plan {detail.acceptedPlanId.slice(0, 8)}… accepted.</p>
              )}
            </div>
          )}
        </div>
      )}
      {message !== null && (
        <p role="status" className="text-[11px] text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}
