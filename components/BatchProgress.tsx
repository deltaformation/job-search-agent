"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
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

  const refresh = useCallback(async () => {
    try {
      setView(await apiGet<BatchView>(`/api/intake/batches/${batchId}`));
      setError(null);
    } catch (error: unknown) {
      setError(errorMessage(error));
    }
  }, [batchId]);

  useEffect(() => {
    // Intentional fetch-on-mount: refresh only sets state after a network
    // round-trip, so this cannot cascade renders.
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
    return <p role="alert">Could not load this batch: {error}</p>;
  }
  if (view === null) {
    return <p>Loading batch…</p>;
  }
  return (
    <section aria-labelledby="batch-heading">
      <h1 id="batch-heading" className="text-2xl font-semibold">
        Batch progress
      </h1>
      <p aria-live="polite" className="mt-2">
        {view.enqueuedCount} queued, {view.duplicateCount} duplicate,{" "}
        {view.invalidCount} invalid, {view.blockedCount} blocked, of{" "}
        {view.rawLineCount} pasted lines.
      </p>
      <p className="mt-1 text-sm">
        <button
          type="button"
          onClick={() => void refresh()}
          className="underline"
        >
          Refresh now
        </button>{" "}
        (auto-refreshes every {REFRESH_MS / 1000} seconds)
      </p>
      {error !== null && (
        <p role="alert" className="mt-2 font-semibold">
          Refresh failed: {error}
        </p>
      )}
      <table className="mt-4 w-full border-collapse border text-left">
        <thead>
          <tr>
            <th scope="col" className="border p-2">Line</th>
            <th scope="col" className="border p-2">URL</th>
            <th scope="col" className="border p-2">Intake</th>
            <th scope="col" className="border p-2">Queue</th>
            <th scope="col" className="border p-2">Detail</th>
          </tr>
        </thead>
        <tbody>
          {view.items.map((item) => (
            <tr key={item.id}>
              <td className="border p-2">{item.lineNumber}</td>
              <td className="break-all border p-2">{item.rawInput}</td>
              <td className="border p-2">
                <OutcomeLabel outcome={item.outcome} />
                {item.reasonCode === null ? "" : ` (${item.reasonCode})`}
              </td>
              <td className="border p-2">
                {item.queue === null ? (
                  "—"
                ) : (
                  <>
                    <WorkStateLabel state={item.queue.workState} /> (
                    {item.queue.attemptCount}/{item.queue.maxAttempts}){" "}
                    <Link
                      href={`/attempts/${item.queue.workItemId}`}
                      className="underline"
                    >
                      details
                    </Link>
                  </>
                )}
              </td>
              <td className="border p-2">{item.canonicalUrl ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
