"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkItemView } from "@/src/server/queries";
import { apiGet, apiPost, errorMessage } from "./api";
import { OutcomeLabel, WorkStateLabel } from "./outcome-label";

/**
 * One work item end to end: queue state, worker attempts, intake line,
 * scrape result, extracted job, evidence links, and the human retry
 * action. External links use only server-validated http(s) URLs; raw
 * pasted text renders as text, never as a link target.
 */
const REFRESH_MS = 5000;

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline">
      {children}
    </a>
  );
}

export default function AttemptView({ workItemId }: { workItemId: string }) {
  const [view, setView] = useState<WorkItemView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setView(await apiGet<WorkItemView>(`/api/attempts/${workItemId}`));
      setError(null);
    } catch (error: unknown) {
      setError(errorMessage(error));
    }
  }, [workItemId]);

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

  async function onRetry(): Promise<void> {
    setRetrying(true);
    setNotice(null);
    try {
      await apiPost(`/api/attempts/${workItemId}/retry`, {});
      setNotice("Requeued with a fresh attempt budget.");
      await refresh();
    } catch (error: unknown) {
      setNotice(`Retry failed: ${errorMessage(error)}`);
    } finally {
      setRetrying(false);
    }
  }

  if (error !== null && view === null) {
    return <p role="alert">Could not load this work item: {error}</p>;
  }
  if (view === null) {
    return <p>Loading work item…</p>;
  }
  const { workItem, intakeItem, job } = view;
  return (
    <div>
      <section aria-labelledby="attempt-heading">
        <h1 id="attempt-heading" className="text-2xl font-semibold">
          Attempt details
        </h1>
        <dl className="mt-2">
          <dt className="font-semibold">Queue state</dt>
          <dd>
            <WorkStateLabel state={workItem.state} /> — attempt{" "}
            {workItem.attemptCount} of {workItem.maxAttempts} ({workItem.kind})
          </dd>
          {workItem.nextRunAt !== null && workItem.state === "QUEUED" && (
            <>
              <dt className="font-semibold">Next run</dt>
              <dd>{workItem.nextRunAt}</dd>
            </>
          )}
        </dl>
        <p className="mt-2 text-sm">
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
      </section>

      {intakeItem !== null && (
        <section aria-labelledby="intake-line-heading" className="mt-6">
          <h2 id="intake-line-heading" className="text-xl font-semibold">
            Intake line {intakeItem.lineNumber}
          </h2>
          <p className="mt-1 break-all">{intakeItem.rawInput}</p>
          <p className="mt-1">
            <OutcomeLabel outcome={intakeItem.outcome} />
            {intakeItem.reasonCode === null ? "" : ` (${intakeItem.reasonCode})`}
          </p>
        </section>
      )}

      <section aria-labelledby="attempts-heading" className="mt-6">
        <h2 id="attempts-heading" className="text-xl font-semibold">
          Worker attempts
        </h2>
        {view.attempts.length === 0 ? (
          <p className="mt-1">No worker attempts yet.</p>
        ) : (
          <table className="mt-2 w-full border-collapse border text-left">
            <thead>
              <tr>
                <th scope="col" className="border p-2">#</th>
                <th scope="col" className="border p-2">Result</th>
                <th scope="col" className="border p-2">Error</th>
                <th scope="col" className="border p-2">Finished</th>
              </tr>
            </thead>
            <tbody>
              {view.attempts.map((attempt) => (
                <tr key={attempt.attemptNumber}>
                  <td className="border p-2">{attempt.attemptNumber}</td>
                  <td className="border p-2">{attempt.result}</td>
                  <td className="border p-2">
                    {attempt.errorCode ?? "—"}
                    {attempt.errorDetail === null ? "" : `: ${attempt.errorDetail}`}
                  </td>
                  <td className="border p-2">{attempt.finishedAt ?? "running"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {view.scrapeOutcome !== null && (
        <section aria-labelledby="scrape-heading" className="mt-6">
          <h2 id="scrape-heading" className="text-xl font-semibold">
            Latest fetch
          </h2>
          <p className="mt-1">
            {view.scrapeOutcome}
            {view.scrapeReasonCode === null ? "" : ` (${view.scrapeReasonCode})`}
          </p>
          {view.scrapeDetail !== null && <p className="mt-1">{view.scrapeDetail}</p>}
        </section>
      )}

      {job !== null && (
        <section aria-labelledby="job-heading" className="mt-6">
          <h2 id="job-heading" className="text-xl font-semibold">
            Extracted job
          </h2>
          <dl className="mt-1">
            <dt className="font-semibold">Title</dt>
            <dd>{job.title ?? "unknown"}</dd>
            <dt className="font-semibold">Company</dt>
            <dd>{job.company ?? "unknown"}</dd>
            <dt className="font-semibold">Location</dt>
            <dd>
              {job.location ?? "unknown"}
              {job.arrangement === null ? "" : ` (${job.arrangement})`}
            </dd>
            <dt className="font-semibold">Salary</dt>
            <dd>{job.salaryText ?? "unknown"}</dd>
            <dt className="font-semibold">Posted</dt>
            <dd>{job.postedAt ?? "unknown"}</dd>
          </dl>
          <p className="mt-2 text-sm">
            Extractor: {job.adapter ?? "none"}
            {job.confidence === null ? "" : `, confidence ${job.confidence}`}
            {job.missingFields.length === 0
              ? "; no missing fields."
              : `; missing: ${job.missingFields.join(", ")}.`}
          </p>
          {job.applyUrl !== null && (
            <p className="mt-2">
              <ExternalLink href={job.applyUrl}>Open the posting to apply manually</ExternalLink>
            </p>
          )}
        </section>
      )}

      {view.artifacts.length > 0 && (
        <section aria-labelledby="evidence-heading" className="mt-6">
          <h2 id="evidence-heading" className="text-xl font-semibold">
            Evidence
          </h2>
          <ul className="mt-1 list-disc pl-6">
            {view.artifacts.map((artifact) => (
              <li key={artifact.id}>
                {artifact.kind} ({artifact.byteSize} bytes) —{" "}
                <ExternalLink href={`/api/evidence/${artifact.id}`}>view</ExternalLink>{" "}
                <a
                  href={`/api/evidence/${artifact.id}?download=1`}
                  className="underline"
                >
                  download
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="retry-heading" className="mt-6">
        <h2 id="retry-heading" className="text-xl font-semibold">
          Retry
        </h2>
        {workItem.state === "FAILED" ? (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => void onRetry()}
              disabled={retrying}
              className="border px-4 py-2 font-semibold disabled:opacity-50"
            >
              {retrying ? "Requeueing…" : "Retry this item"}
            </button>
            <p className="mt-1 text-sm">
              Grants a fresh attempt budget and requeues immediately.
            </p>
          </div>
        ) : (
          <p className="mt-1">Only finished failed items can be retried.</p>
        )}
        {notice !== null && (
          <p role="status" className="mt-2 font-semibold">
            {notice}
          </p>
        )}
      </section>
    </div>
  );
}
