"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Briefcase,
  Clock,
  Download,
  ExternalLink as ExternalLinkIcon,
  FileCode,
  FileText,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { WorkItemView } from "@/src/server/queries";
import type { IngestClipResult } from "@/src/server/clip";
import { apiGet, apiPost, errorMessage } from "./api";
import { OutcomeLabel, WorkStateLabel } from "./outcome-label";

/**
 * One work item end to end: queue state, worker attempts, intake line,
 * scrape result, extracted job, evidence links, and the human retry
 * action. External links use only server-validated http(s) URLs; raw
 * pasted text renders as text, never as a link target.
 */
const REFRESH_MS = 5000;

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline hover:text-foreground transition-colors">
      {children}
    </a>
  );
}

export default function AttemptView({ workItemId }: { workItemId: string }) {
  const [view, setView] = useState<WorkItemView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [content, setContent] = useState("");
  const [pasting, setPasting] = useState(false);
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      setView(await apiGet<WorkItemView>(`/api/attempts/${workItemId}`));
      setError(null);
    } catch (error: unknown) {
      setError(errorMessage(error));
    } finally {
      setIsRefreshing(false);
    }
  }, [workItemId]);

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

  async function onPasteSubmit(): Promise<void> {
    setPasting(true);
    setPasteNotice(null);
    try {
      const result = await apiPost<IngestClipResult>(
        `/api/attempts/${workItemId}/content`,
        { html: content },
      );
      if (result.outcome === "created") {
        setPasteNotice("Content ingested: NEW job created.");
      } else if (result.outcome === "duplicate") {
        setPasteNotice("Already tracked: no new card was created.");
      } else {
        setPasteNotice(`Ingestion rejected: ${result.detail}`);
      }
      await refresh();
    } catch (error: unknown) {
      setPasteNotice(`Paste failed: ${errorMessage(error)}`);
    } finally {
      setPasting(false);
    }
  }

  if (error !== null && view === null) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-destructive/20 bg-destructive/10 p-5 text-sm font-semibold text-destructive"
      >
        Could not load this work item: {error}
      </div>
    );
  }

  if (view === null) {
    return (
      <div className="rounded-xl border border-border/70 bg-card p-12 text-center shadow-xs">
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Sparkles className="h-5 w-5 animate-spin text-primary" />
          <span>Loading work item…</span>
        </div>
      </div>
    );
  }

  const { workItem, intakeItem, job } = view;

  return (
    <div className="space-y-6">
      {/* Top Header Card */}
      <section
        aria-labelledby="attempt-heading"
        className="rounded-xl border border-border/70 bg-card p-6 shadow-xs text-card-foreground"
      >
        <div className="border-b border-border/60 pb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 id="attempt-heading" className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
              <Activity className="h-6 w-6 text-primary" />
              <span>Attempt details</span>
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Inspection and retry diagnostics for background queue work items.
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

        <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
            <dt className="font-semibold text-muted-foreground uppercase tracking-wider text-[11px]">
              Queue state
            </dt>
            <dd className="mt-1 flex items-center gap-1.5 font-medium text-foreground">
              <WorkStateLabel state={workItem.state} />
              <span>
                — attempt {workItem.attemptCount} of {workItem.maxAttempts} ({workItem.kind})
              </span>
            </dd>
          </div>

          {workItem.nextRunAt !== null && workItem.state === "QUEUED" && (
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
              <dt className="font-semibold text-muted-foreground uppercase tracking-wider text-[11px]">
                Next run
              </dt>
              <dd className="mt-1 font-mono text-foreground font-medium">
                {workItem.nextRunAt}
              </dd>
            </div>
          )}
        </dl>

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
      </section>

      {/* Intake Line Card */}
      {intakeItem !== null && (
        <section
          aria-labelledby="intake-line-heading"
          className="rounded-xl border border-border/70 bg-card p-6 shadow-xs text-card-foreground"
        >
          <div className="flex items-center justify-between border-b border-border/60 pb-3">
            <h2 id="intake-line-heading" className="text-base font-bold tracking-tight text-foreground flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              <span>Intake line {intakeItem.lineNumber}</span>
            </h2>
            <OutcomeLabel outcome={intakeItem.outcome} />
          </div>

          <div className="mt-3 rounded-md border border-input bg-muted/20 p-3 font-mono text-xs break-all text-foreground">
            {intakeItem.rawInput}
          </div>

          {intakeItem.reasonCode !== null && (
            <p className="mt-2 text-xs text-muted-foreground">
              Reason: <span className="font-mono">{intakeItem.reasonCode}</span>
            </p>
          )}
        </section>
      )}

      {/* Worker Attempts Table */}
      <section
        aria-labelledby="attempts-heading"
        className="rounded-xl border border-border/70 bg-card p-6 shadow-xs text-card-foreground"
      >
        <div className="border-b border-border/60 pb-3">
          <h2 id="attempts-heading" className="text-base font-bold tracking-tight text-foreground flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            <span>Worker attempts</span>
          </h2>
        </div>

        {view.attempts.length === 0 ? (
          <p className="mt-4 text-xs text-muted-foreground">No worker attempts yet.</p>
        ) : (
          <div className="mt-4 overflow-hidden rounded-lg border border-border/80">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-muted/50 text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/80">
                <tr>
                  <th scope="col" className="p-3 w-14 text-center">#</th>
                  <th scope="col" className="p-3 w-28">Result</th>
                  <th scope="col" className="p-3">Error</th>
                  <th scope="col" className="p-3 w-44">Finished</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {view.attempts.map((attempt) => (
                  <tr key={attempt.attemptNumber} className="hover:bg-muted/30 transition-colors">
                    <td className="p-3 text-center text-xs font-mono text-muted-foreground">
                      {attempt.attemptNumber}
                    </td>
                    <td className="p-3">
                      <Badge
                        variant={attempt.result === "SUCCEEDED" ? "success" : "destructive"}
                        className="text-xs"
                      >
                        {attempt.result}
                      </Badge>
                    </td>
                    <td className="p-3 text-xs text-muted-foreground">
                      {attempt.errorCode ?? "—"}
                      {attempt.errorDetail === null ? "" : `: ${attempt.errorDetail}`}
                    </td>
                    <td className="p-3 text-xs font-mono text-muted-foreground">
                      {attempt.finishedAt ?? "running"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Latest Fetch */}
      {view.scrapeOutcome !== null && (
        <section
          aria-labelledby="scrape-heading"
          className="rounded-xl border border-border/70 bg-card p-6 shadow-xs text-card-foreground"
        >
          <h2 id="scrape-heading" className="text-base font-bold tracking-tight text-foreground flex items-center gap-2 mb-2">
            <Activity className="h-4 w-4 text-primary" />
            <span>Latest fetch</span>
          </h2>
          <div className="text-xs space-y-1">
            <p className="font-medium text-foreground">
              {view.scrapeOutcome}
              {view.scrapeReasonCode === null ? "" : ` (${view.scrapeReasonCode})`}
            </p>
            {view.scrapeDetail !== null && (
              <p className="text-muted-foreground">{view.scrapeDetail}</p>
            )}
          </div>
        </section>
      )}

      {/* Paste Content Form for Captcha/Incomplete */}
      {(view.scrapeReasonCode === "CAPTCHA_REQUIRED" ||
        view.scrapeReasonCode === "EXTRACTION_INCOMPLETE") && (
        <section
          aria-labelledby="paste-heading"
          className="rounded-xl border border-amber-200 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-950/20 p-6 shadow-xs"
        >
          <h2 id="paste-heading" className="text-base font-bold tracking-tight text-amber-900 dark:text-amber-300 flex items-center gap-2">
            <AlertTriangle className="h-5 w-5" />
            <span>Paste page content</span>
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            The automated fetch was blocked. Open the posting in your own
            browser, copy the page (View Source → Select All works best), and
            paste it here to ingest it directly.
          </p>
          <div className="mt-3">
            <Button
              type="button"
              aria-expanded={drawerOpen}
              aria-controls="paste-drawer"
              onClick={() => setDrawerOpen((open) => !open)}
              variant="outline"
              size="sm"
              className="font-semibold text-xs"
            >
              {drawerOpen ? "Hide paste box" : "Paste content"}
            </Button>
          </div>

          {drawerOpen && (
            <div id="paste-drawer" className="mt-4 space-y-3 pt-3 border-t border-amber-200/60 dark:border-amber-900/50">
              <label htmlFor="paste-content" className="block text-xs font-semibold text-foreground">
                Page HTML or visible text
              </label>
              <textarea
                id="paste-content"
                rows={8}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder="Paste the page HTML here"
                className="w-full rounded-lg border border-input bg-background p-3 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button
                type="button"
                onClick={() => void onPasteSubmit()}
                disabled={pasting || content.trim() === ""}
                size="sm"
                className="font-semibold text-xs"
              >
                {pasting ? "Ingesting…" : "Ingest pasted content"}
              </Button>
            </div>
          )}

          {pasteNotice !== null && (
            <p role="status" className="mt-3 text-xs font-semibold text-amber-900 dark:text-amber-300">
              {pasteNotice}
            </p>
          )}
        </section>
      )}

      {/* Extracted Job Card */}
      {job !== null && (
        <section
          aria-labelledby="job-heading"
          className="rounded-xl border border-border/70 bg-card p-6 shadow-xs text-card-foreground"
        >
          <h2 id="job-heading" className="text-base font-bold tracking-tight text-foreground flex items-center gap-2 border-b border-border/60 pb-3">
            <Briefcase className="h-4 w-4 text-primary" />
            <span>Extracted job</span>
          </h2>

          <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="rounded-md border border-border/60 bg-muted/20 p-2.5">
              <dt className="font-semibold text-muted-foreground">Title</dt>
              <dd className="mt-0.5 font-bold text-sm text-foreground">{job.title ?? "unknown"}</dd>
            </div>
            <div className="rounded-md border border-border/60 bg-muted/20 p-2.5">
              <dt className="font-semibold text-muted-foreground">Company</dt>
              <dd className="mt-0.5 font-bold text-sm text-foreground">{job.company ?? "unknown"}</dd>
            </div>
            <div className="rounded-md border border-border/60 bg-muted/20 p-2.5">
              <dt className="font-semibold text-muted-foreground">Location</dt>
              <dd className="mt-0.5 font-medium text-foreground">
                {job.location ?? "unknown"}
                {job.arrangement === null ? "" : ` (${job.arrangement})`}
              </dd>
            </div>
            <div className="rounded-md border border-border/60 bg-muted/20 p-2.5">
              <dt className="font-semibold text-muted-foreground">Salary</dt>
              <dd className="mt-0.5 font-medium text-foreground">{job.salaryText ?? "unknown"}</dd>
            </div>
            <div className="rounded-md border border-border/60 bg-muted/20 p-2.5">
              <dt className="font-semibold text-muted-foreground">Posted</dt>
              <dd className="mt-0.5 font-medium text-foreground">{job.postedAt ?? "unknown"}</dd>
            </div>
          </dl>

          <p className="mt-3 text-xs text-muted-foreground">
            Extractor: {job.adapter ?? "none"}
            {job.confidence === null ? "" : `, confidence ${job.confidence}`}
            {job.missingFields.length === 0
              ? "; no missing fields."
              : `; missing: ${job.missingFields.join(", ")}.`}
          </p>

          {job.applyUrl !== null && (
            <div className="mt-4 pt-3 border-t border-border/60">
              <ExternalLink href={job.applyUrl}>
                <span className="font-semibold text-primary inline-flex items-center gap-1 text-xs">
                  Open the posting to apply manually <ExternalLinkIcon className="h-3 w-3" />
                </span>
              </ExternalLink>
            </div>
          )}
        </section>
      )}

      {/* Evidence Files */}
      {view.artifacts.length > 0 && (
        <section
          aria-labelledby="evidence-heading"
          className="rounded-xl border border-border/70 bg-card p-6 shadow-xs text-card-foreground"
        >
          <h2 id="evidence-heading" className="text-base font-bold tracking-tight text-foreground flex items-center gap-2 border-b border-border/60 pb-3">
            <FileCode className="h-4 w-4 text-primary" />
            <span>Evidence</span>
          </h2>
          <ul className="mt-3 space-y-2 text-xs">
            {view.artifacts.map((artifact) => (
              <li key={artifact.id} className="flex items-center justify-between rounded-md border border-border/60 bg-muted/20 p-2.5">
                <span className="font-medium">
                  {artifact.kind} ({artifact.byteSize} bytes)
                </span>
                <div className="flex items-center gap-3 font-semibold text-primary">
                  <a
                    href={`/api/evidence/${artifact.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline hover:text-primary/80"
                  >
                    view
                  </a>
                  <a
                    href={`/api/evidence/${artifact.id}?download=1`}
                    className="underline hover:text-primary/80 inline-flex items-center gap-0.5"
                  >
                    download <Download className="h-2.5 w-2.5" />
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Retry Section */}
      <section
        aria-labelledby="retry-heading"
        className="rounded-xl border border-border/70 bg-card p-6 shadow-xs text-card-foreground"
      >
        <h2 id="retry-heading" className="text-base font-bold tracking-tight text-foreground flex items-center gap-2 border-b border-border/60 pb-3">
          <RotateCcw className="h-4 w-4 text-primary" />
          <span>Retry</span>
        </h2>
        {workItem.state === "FAILED" ? (
          <div className="mt-3 space-y-2">
            <Button
              type="button"
              onClick={() => void onRetry()}
              disabled={retrying}
              className="gap-2 text-xs font-semibold"
            >
              <RotateCcw className={`h-3.5 w-3.5 ${retrying ? "animate-spin" : ""}`} />
              {retrying ? "Requeueing…" : "Retry this item"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Grants a fresh attempt budget and requeues immediately.
            </p>
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            Only finished failed items can be retried.
          </p>
        )}

        {notice !== null && (
          <div
            role="status"
            className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs font-semibold text-primary"
          >
            {notice}
          </div>
        )}
      </section>
    </div>
  );
}
