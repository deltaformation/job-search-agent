"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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
    <section aria-labelledby="recent-batches-heading" className="mt-10">
      <h2 id="recent-batches-heading" className="text-xl font-semibold">
        Recent batches
      </h2>
      {error !== null && (
        <p role="alert" className="mt-2">
          Could not load batches: {error}
        </p>
      )}
      {batches === null && error === null && (
        <p className="mt-2">Loading batches…</p>
      )}
      {batches !== null && batches.length === 0 && (
        <p className="mt-2">No batches yet — paste URLs above to start.</p>
      )}
      {batches !== null && batches.length > 0 && (
        <table className="mt-2 w-full border-collapse border text-left">
          <thead>
            <tr>
              <th scope="col" className="border p-2">Created</th>
              <th scope="col" className="border p-2">Queued</th>
              <th scope="col" className="border p-2">Duplicate</th>
              <th scope="col" className="border p-2">Invalid</th>
              <th scope="col" className="border p-2">Blocked</th>
              <th scope="col" className="border p-2">Batch</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((batch) => (
              <tr key={batch.id}>
                <td className="border p-2">{batch.createdAt}</td>
                <td className="border p-2">{batch.enqueuedCount}</td>
                <td className="border p-2">{batch.duplicateCount}</td>
                <td className="border p-2">{batch.invalidCount}</td>
                <td className="border p-2">{batch.blockedCount}</td>
                <td className="border p-2">
                  <Link href={`/intake/batches/${batch.id}`} className="underline">
                    open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
