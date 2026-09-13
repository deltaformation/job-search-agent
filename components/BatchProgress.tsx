"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Activity, ArrowRight, ExternalLink, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BatchView } from "@/src/server/queries";
import { apiGet, errorMessage } from "./api";
import { OutcomeLabel, WorkStateLabel } from "./outcome-label";

/**
 * Batch progress with per-line outcomes and live queue state. Refreshes
 * on an interval (skipped while the tab is hidden) plus a manual
 * button; the summary line is a polite live region.
 */
const REFRESH_MS = 5000;

export default function BatchProgress({ batchId }: { batchId: string }) {
  const [view, setView] = useState<BatchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      setView(await apiGet<BatchView>(`/api/intake/batches/${batchId}`));
      setError(null);
    } catch (error: unknown) {
      setError(errorMessage(error));
    } finally {
      setIsRefreshing(false);
    }
  }, [batchId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) {
        void refresh();
      }
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (error !== null && view === null) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-destructive/20 bg-destructive/10 p-5 text-sm font-semibold text-destructive"
      >
        Could not load this batch: {error}
      </div>
    );
  }

  if (view === null) {
    return (
      <div className="rounded-xl border border-border/70 bg-card p-12 text-center shadow-xs">
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Sparkles className="h-5 w-5 animate-spin text-primary" />
          <span>Loading batch…</span>
        </div>
      </div>
    );
  }

  return (
    <section
      aria-labelledby="batch-heading"
      className="rounded-xl border border-border/70 bg-card p-6 shadow-xs text-card-foreground"
    >
      <div className="border-b border-border/60 pb-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 id="batch-heading" className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
              <Activity className="h-6 w-6 text-primary" />
              <span>Batch progress</span>
            </h1>
            <p aria-live="polite" className="mt-1 text-sm text-muted-foreground">
              {view.enqueuedCount} queued, {view.duplicateCount} duplicate,{" "}
              {view.invalidCount} invalid, {view.blockedCount} blocked, of{" "}
              {view.rawLineCount} pasted lines.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              disabled={isRefreshing}
              className="gap-1.5 text-xs font-medium"
            >
              <RotateCcw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
              <span>Refresh now</span>
            </Button>
          </div>
        </div>

        <p className="mt-2 text-xs text-muted-foreground">
          Auto-refreshes every {REFRESH_MS / 1000} seconds.
        </p>

        {error !== null && (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-xs font-semibold text-destructive"
          >
            Refresh failed: {error}
          </div>
        )}
      </div>

      {/* Summary KPI Pills */}
      <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg border border-sky-200/60 bg-sky-50/50 dark:bg-sky-950/20 p-3 text-center">
          <span className="block text-xs font-medium text-sky-800 dark:text-sky-300 uppercase tracking-wider">
            Queued URLs
          </span>
          <span className="text-xl font-bold text-sky-950 dark:text-sky-100">
            {view.enqueuedCount}
          </span>
        </div>
        <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-center">
          <span className="block text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Duplicate URLs
          </span>
          <span className="text-xl font-bold text-foreground">
            {view.duplicateCount}
          </span>
        </div>
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-center">
          <span className="block text-xs font-medium text-destructive uppercase tracking-wider">
            Invalid URLs
          </span>
          <span className="text-xl font-bold text-destructive">
            {view.invalidCount}
          </span>
        </div>
        <div className="rounded-lg border border-amber-200/60 bg-amber-50/50 dark:bg-amber-950/20 p-3 text-center">
          <span className="block text-xs font-medium text-amber-800 dark:text-amber-300 uppercase tracking-wider">
            Blocked URLs
          </span>
          <span className="text-xl font-bold text-amber-950 dark:text-amber-100">
            {view.blockedCount}
          </span>
        </div>
      </div>

      {/* Per-line Outcomes Table */}
      <div className="mt-6 overflow-x-auto rounded-lg border border-border/80">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-muted/50 text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/80">
            <tr>
              <th scope="col" className="p-3 w-16 text-center">Line</th>
              <th scope="col" className="p-3">URL</th>
              <th scope="col" className="p-3 w-28">Intake</th>
              <th scope="col" className="p-3 w-40">Queue</th>
              <th scope="col" className="p-3">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {view.items.map((item) => (
              <tr key={item.id} className="hover:bg-muted/30 transition-colors">
                <td className="p-3 text-center text-xs font-mono text-muted-foreground">
                  {item.lineNumber}
                </td>
                <td className="p-3 break-all font-mono text-xs text-foreground">
                  {item.rawInput}
                </td>
                <td className="p-3">
                  <OutcomeLabel outcome={item.outcome} />
                  {item.reasonCode !== null && (
                    <span className="block text-[11px] text-muted-foreground mt-0.5">
                      ({item.reasonCode})
                    </span>
                  )}
                </td>
                <td className="p-3 text-xs">
                  {item.queue === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-1.5">
                        <WorkStateLabel state={item.queue.workState} />
                        <span className="font-mono text-muted-foreground text-[11px]">
                          ({item.queue.attemptCount}/{item.queue.maxAttempts})
                        </span>
                      </div>
                      <Link
                        href={`/attempts/${item.queue.workItemId}`}
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary underline hover:text-primary/80"
                      >
                        <span>details</span>
                        <ArrowRight className="h-2.5 w-2.5" />
                      </Link>
                    </div>
                  )}
                </td>
                <td className="p-3 text-xs text-muted-foreground break-all">
                  {item.canonicalUrl ? (
                    <a
                      href={item.canonicalUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      <span>{item.canonicalUrl}</span>
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
