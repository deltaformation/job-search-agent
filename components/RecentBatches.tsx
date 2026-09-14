"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, History, Sparkles } from "lucide-react";
import type { BatchSummary } from "@/src/server/queries";
import { apiGet, errorMessage } from "./api";

/** Recent intake batches, newest first. */
export default function RecentBatches() {
  const [batches, setBatches] = useState<BatchSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet<{ batches: BatchSummary[] }>("/api/intake/batches?limit=10")
      .then((body) => {
        if (!cancelled) {
          setBatches(body.batches);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setError(errorMessage(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section
      aria-labelledby="recent-batches-heading"
      className="rounded-xl border border-border/70 bg-card/60 p-4 sm:p-5 shadow-xs backdrop-blur-xs text-card-foreground"
    >
      <div className="border-b border-border/60 pb-3">
        <h2 id="recent-batches-heading" className="text-base sm:text-lg font-bold tracking-tight text-foreground flex items-center gap-2">
          <History className="size-4 text-primary" aria-hidden="true" />
          <span>Recent Batches</span>
        </h2>
        <p className="mt-0.5 text-xs sm:text-sm text-muted-foreground">
          Track previously submitted URL batches, their progress, and scrape results.
        </p>
      </div>

      {error !== null && (
        <div
          role="alert"
          className="mt-3.5 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-xs sm:text-sm font-semibold text-destructive"
        >
          Could not load batches: {error}
        </div>
      )}

      {batches === null && error === null && (
        <div className="mt-3.5 flex items-center gap-2 text-xs text-muted-foreground">
          <Sparkles className="size-3.5 animate-spin text-primary" />
          <span>Loading batches…</span>
        </div>
      )}

      {batches !== null && batches.length === 0 && (
        <div className="mt-6 rounded-lg border border-dashed border-border/80 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No batches yet — paste URLs above to start.
          </p>
        </div>
      )}

      {batches !== null && batches.length > 0 && (
        <div className="mt-5 overflow-x-auto rounded-lg border border-border/80">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-muted/50 text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/80">
              <tr>
                <th scope="col" className="p-3">Created</th>
                <th scope="col" className="p-3 text-center">Queued</th>
                <th scope="col" className="p-3 text-center">Duplicate</th>
                <th scope="col" className="p-3 text-center">Invalid</th>
                <th scope="col" className="p-3 text-center">Blocked</th>
                <th scope="col" className="p-3 text-right">Batch</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {batches.map((batch) => (
                <tr key={batch.id} className="hover:bg-muted/30 transition-colors">
                  <td className="p-3 text-xs font-mono text-muted-foreground">
                    {batch.createdAt}
                  </td>
                  <td className="p-3 text-center">
                    <span className="inline-block rounded px-2 py-0.5 text-xs font-semibold bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-300">
                      {batch.enqueuedCount}
                    </span>
                  </td>
                  <td className="p-3 text-center text-xs text-muted-foreground font-medium">
                    {batch.duplicateCount}
                  </td>
                  <td className="p-3 text-center text-xs">
                    {batch.invalidCount > 0 ? (
                      <span className="inline-block rounded px-2 py-0.5 font-semibold bg-destructive/10 text-destructive">
                        {batch.invalidCount}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </td>
                  <td className="p-3 text-center text-xs">
                    {batch.blockedCount > 0 ? (
                      <span className="inline-block rounded px-2 py-0.5 font-semibold bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                        {batch.blockedCount}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </td>
                  <td className="p-3 text-right">
                    <Link
                      href={`/intake/batches/${batch.id}`}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-primary underline underline-offset-4 hover:text-primary/80 transition-colors"
                    >
                      open <ArrowRight className="h-3 w-3" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
