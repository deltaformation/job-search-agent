"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  Briefcase,
  CheckCircle2,
  Clock,
  ExternalLink,
  History,
  MessageSquare,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { BoardStatus } from "@/src/domain/enums";
import type { BoardCardView, JobDetailView } from "@/src/server/board";
import { apiGet, apiPost, errorMessage } from "../api";
import AddNoteForm from "./AddNoteForm";
import Dialog from "./dialog";
import { postJobMutation } from "./mutate";
import ResumeReview from "./ResumeReview";
import { formatSalaryRange } from "./salaryFormat";
import { tailoringReasonCopy } from "./tailoringCopy";

/**
 * Card detail drawer: facts, source links, attempts, missing fields,
 * resumes, notes, the application record, workflow history, and intake
 * provenance — plus the keyboard-operable action path (move menu,
 * correction, application recording) that mirrors drag and drop.
 */

const ORDINARY_TARGETS: Record<BoardStatus, BoardStatus[]> = {
  NEW: ["REJECTED"],
  TAILORED: ["APPLIED", "REJECTED"],
  APPLIED: ["INTERVIEWED", "REJECTED"],
  INTERVIEWED: ["REJECTED"],
  REJECTED: [],
};

function pretty(value: string | null): string {
  if (value === null || value === "") {
    return "Unknown";
  }
  const lower = value.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Client-observed run clock. Attempt rows are written at completion, so
 * while RUNNING the elapsed time counts from when this banner mounted
 * (opening the tab on an in-flight run starts near zero). Mounted only
 * while the progress banner renders, so every run starts at zero
 * without reset bookkeeping.
 */
function RunElapsedClock() {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  return <span>Tailoring in progress ({elapsed}s elapsed)</span>;
}

interface CardDrawerProps {
  jobId: string;
  refreshToken: number;
  onClose: () => void;
  onChanged: () => void;
  onCorrect: (card: BoardCardView) => void;
  onApplied: (card: BoardCardView, rank: number) => void;
  onReject: (card: BoardCardView, rank: number) => void;
}

export default function CardDrawer({
  jobId,
  refreshToken,
  onClose,
  onChanged,
  onCorrect,
  onApplied,
  onReject,
}: CardDrawerProps) {
  const [detail, setDetail] = useState<JobDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState<BoardStatus | "">("");
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [matchSummary, setMatchSummary] = useState<string>("Select a resume to inspect its requirement matches.");
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);

  const refreshDetail = useCallback(async (): Promise<void> => {
    try {
      setDetail(await apiGet<JobDetailView>(`/api/jobs/${jobId}`));
      setError(null);
    } catch (fetchError: unknown) {
      setError(errorMessage(fetchError));
    }
  }, [jobId]);

  useEffect(() => {
    // Intentional fetch-on-mount/refresh: refreshDetail only sets state
    // after a network round-trip, so this cannot cascade renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshDetail();
  }, [refreshDetail, refreshToken]);

  const tailoringState = detail?.job.tailoringState ?? null;
  const tailoringLive = tailoringState === "PENDING" || tailoringState === "RUNNING";

  useEffect(() => {
    // Active polling while a tailoring run is queued or in flight: the
    // drawer flips to the review view (or the error card) on its own —
    // no manual refresh. Idle while terminal or undecided.
    if (!tailoringLive) {
      return;
    }
    const timer = setInterval(() => {
      void refreshDetail();
    }, 2000);
    return () => clearInterval(timer);
  }, [tailoringLive, refreshDetail]);

  async function onRetryTailoring(): Promise<void> {
    setRetrying(true);
    setRetryNotice(null);
    setActionError(null);
    try {
      const result = await apiPost<{ workItemId: string; action: string }>(
        `/api/jobs/${jobId}/tailor/retry`,
        {},
      );
      setRetryNotice(
        result.action === "requeued" || result.action === "enqueued"
          ? "Tailoring restarted — watching for the new run."
          : `Tailoring already ${result.action.replace("already_", "")} — watching for updates.`,
      );
      onChanged();
      await refreshDetail();
    } catch (retryError: unknown) {
      setActionError(errorMessage(retryError));
    } finally {
      setRetrying(false);
    }
  }

  function asCard(view: JobDetailView): BoardCardView {
    const active = view.resumes.find((resume) => resume.id === view.job.activeResumeVersionId);
    return {
      id: view.job.id,
      status: view.job.status,
      rank: view.job.rank,
      rowVersion: view.job.rowVersion,
      title: view.job.title,
      company: view.job.company,
      location: view.job.location,
      arrangement: view.job.arrangement,
      salaryText: view.job.salaryText,
      salaryCurrency: view.job.salaryCurrency,
      salaryMinMinor: view.job.salaryMinMinor,
      salaryMaxMinor: view.job.salaryMaxMinor,
      scrapeState: view.job.scrapeState,
      scrapeReasonCode: view.job.scrapeReasonCode,
      tailoringState: view.job.tailoringState,
      tailoringReasonCode: view.job.tailoringReasonCode,
      resume:
        active === undefined
          ? null
          : { versionId: active.id, version: active.version, reviewState: active.reviewState },
      notesCount: view.notes.length,
      sourceUrl: view.source?.submittedUrl ?? null,
      createdAt: view.job.createdAt,
      updatedAt: view.job.updatedAt,
    };
  }

  async function onMoveSubmit(view: JobDetailView): Promise<void> {
    if (moveTo === "") {
      return;
    }
    const card = asCard(view);
    if (moveTo === "APPLIED") {
      onApplied(card, card.rank);
      return;
    }
    if (moveTo === "REJECTED") {
      onReject(card, card.rank);
      return;
    }
    setActionError(null);
    try {
      await postJobMutation(`/api/jobs/${view.job.id}/move`, {
        to: moveTo,
        rank: card.rank,
        observedRowVersion: card.rowVersion,
      });
      setMoveTo("");
      onChanged();
      await refreshDetail();
    } catch (moveError: unknown) {
      setActionError(errorMessage(moveError));
    }
  }

  const view = detail;

  const renderOverview = (v: JobDetailView) => (
    <div className="space-y-4">
      {/* Job Facts */}
      <section aria-labelledby="drawer-facts" className="rounded-lg border border-border/80 bg-card p-4 space-y-3">
        <h3 id="drawer-facts" className="font-semibold text-sm flex items-center gap-2">
          <Briefcase className="h-4 w-4 text-primary" />
          <span>Facts</span>
        </h3>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div className="rounded-md border border-border/60 bg-muted/20 p-2.5">
            <dt className="font-semibold text-muted-foreground">Work Arrangement</dt>
            <dd className="mt-1 font-medium text-foreground">{v.job.arrangement ?? "Unknown"}</dd>
          </div>
          <div className="rounded-md border border-border/60 bg-muted/20 p-2.5">
            <dt className="font-semibold text-muted-foreground">Salary / Compensation</dt>
            <dd className="mt-1 font-medium text-foreground">
              {formatSalaryRange(v.job) ?? "Unknown"}
            </dd>
          </div>
          <div className="rounded-md border border-border/60 bg-muted/20 p-2.5">
            <dt className="font-semibold text-muted-foreground">Date Posted</dt>
            <dd className="mt-1 font-medium text-foreground">{v.job.postedAt ?? "Unknown"}</dd>
          </div>
          <div className="rounded-md border border-border/60 bg-muted/20 p-2.5">
            <dt className="font-semibold text-muted-foreground">Pipeline Stage</dt>
            <dd className="mt-1 font-medium text-foreground">{pretty(v.job.status)}</dd>
          </div>
          <div className="sm:col-span-2 rounded-md border border-border/60 bg-muted/20 p-3">
            <dt className="font-semibold text-muted-foreground mb-1">Job description</dt>
            <dd className="whitespace-pre-wrap font-sans text-base text-foreground/90 leading-relaxed">
              {v.job.descriptionText ?? "No description extracted."}
            </dd>
          </div>
        </dl>
      </section>

      {/* Missing Information Notice */}
      {v.extraction !== null && v.extraction.missingFields.length > 0 && (
        <div className="rounded-lg border border-amber-200/60 bg-amber-50/50 dark:bg-amber-950/20 p-3.5 text-xs text-amber-900 dark:text-amber-300">
          <span className="font-semibold">Missing from posting:</span>{" "}
          <span className="font-mono">{v.extraction.missingFields.join(", ")}</span>
        </div>
      )}

      {/* Compensation Highlights */}
      {v.compensationHighlights.length > 0 && (
        <section aria-labelledby="drawer-comp" className="rounded-lg border border-border/80 bg-card p-4 space-y-2">
          <h3 id="drawer-comp" className="font-semibold text-sm flex items-center gap-2">
            <Banknote className="h-4 w-4 text-primary" />
            <span>Compensation highlights</span>
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {v.compensationHighlights.map((highlight) => (
              <li key={highlight}>
                <Badge variant="secondary" className="text-xs font-medium">
                  {highlight}
                </Badge>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted-foreground">
            Extras reported beyond base salary; verify against the original posting.
          </p>
        </section>
      )}

      {/* Top 5 ATS Keywords */}
      {v.topKeywords.length > 0 && (
        <section aria-labelledby="drawer-keywords" className="rounded-lg border border-border/80 bg-card p-4 space-y-3">
          <h3 id="drawer-keywords" className="font-semibold text-sm flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span>Top 5 ATS keywords</span>
          </h3>
          {v.topKeywords.some((entry) => entry.evidenced) && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-1.5">
                Evidenced in resume
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {v.topKeywords
                  .filter((entry) => entry.evidenced)
                  .map((entry) => (
                    <li key={entry.keyword}>
                      <Badge variant="success" className="text-xs font-medium">
                        {entry.keyword}
                      </Badge>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {v.topKeywords.some((entry) => !entry.evidenced) && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-1.5">
                Gaps — not on resume
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {v.topKeywords
                  .filter((entry) => !entry.evidenced)
                  .map((entry) => (
                    <li key={entry.keyword}>
                      <Badge variant="outline" className="text-xs font-medium">
                        {entry.keyword}
                      </Badge>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* Source Links */}
      {v.source !== null && (
        <section aria-labelledby="drawer-source" className="rounded-lg border border-border/80 bg-card p-4 space-y-2">
          <h3 id="drawer-source" className="font-semibold text-sm flex items-center gap-2">
            <ExternalLink className="h-4 w-4 text-primary" />
            <span>Source URLs</span>
          </h3>
          <ul className="text-xs space-y-1.5">
            {(
              [
                ["Submitted", v.source.submittedUrl],
                ["Canonical", v.source.canonicalUrl],
                ["Fetched", v.source.finalUrl],
                ["Apply", v.source.applyUrl],
              ] as const
            ).map(
              ([label, url]) =>
                url !== null && (
                  <li key={label} className="flex items-center justify-between gap-2">
                    <span className="font-medium text-muted-foreground">{label}:</span>
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-semibold text-primary underline underline-offset-2 truncate max-w-[340px]"
                    >
                      Open original job posting <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  </li>
                ),
            )}
          </ul>
        </section>
      )}
    </div>
  );

  const renderTailoringAlert = (v: JobDetailView) => {
    const state = v.job.tailoringState;
    if (state !== "FAILED" && state !== "BLOCKED") {
      return null;
    }
    return (
      <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm space-y-2">
        <p className="flex items-center gap-2 font-semibold text-destructive">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <span>Tailoring failed{v.job.tailoringReasonCode !== null ? ` (${pretty(v.job.tailoringReasonCode)})` : ""}</span>
        </p>
        <p className="text-foreground/90">{tailoringReasonCopy(v.job.tailoringReasonCode)}</p>
        {v.tailoringAttempt?.errorDetail && (
          <p className="rounded-md border border-border/60 bg-background p-2 text-xs font-mono break-words">
            {v.tailoringAttempt.errorDetail}
          </p>
        )}
        <div className="flex items-center gap-2 pt-1">
          <Button type="button" size="sm" onClick={() => void onRetryTailoring()} disabled={retrying}>
            <RotateCcw className={`h-3.5 w-3.5 mr-1 ${retrying ? "animate-spin" : ""}`} aria-hidden="true" />
            {retrying ? "Restarting…" : "Retry tailoring"}
          </Button>
        </div>
      </div>
    );
  };

  const renderTailoringProgress = (v: JobDetailView) => {
    const state = v.job.tailoringState;
    if (state === "RUNNING") {
      return (
        <div className="rounded-lg border border-border/80 bg-card p-4 text-sm" role="status" aria-live="polite">
          <p className="flex items-center gap-2 font-semibold">
            <Sparkles className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
            <RunElapsedClock />
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Calling the AI provider to extract verbatim requirements and Top 5 ATS keywords, then
            compiling the resume. This view updates automatically.
          </p>
        </div>
      );
    }
    if (state === "PENDING" && v.resumes.length === 0) {
      return (
        <div className="rounded-lg border border-border/80 bg-card p-4 text-sm" role="status">
          <p className="flex items-center gap-2 font-semibold">
            <Clock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span>Queued for tailoring</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Waiting for the background worker to claim this job. This view updates automatically.
          </p>
        </div>
      );
    }
    return null;
  };

  const renderResumes = (v: JobDetailView) => (
    <section aria-labelledby="drawer-resumes" className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 id="drawer-resumes" className="font-bold text-base flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span>Resumes ({v.resumes.length})</span>
        </h3>
        {v.resumes.length > 0 && (
          <Badge variant="outline" className="text-xs">
            {v.resumes.length} {v.resumes.length === 1 ? "version" : "versions"} generated
          </Badge>
        )}
      </div>

      {renderTailoringProgress(v)}

      {v.resumes.length === 0 && (
        <div className="rounded-lg border border-dashed border-border/80 p-8 text-center">
          <p className="text-sm text-muted-foreground">No tailored resume yet.</p>
        </div>
      )}

      {v.resumes.length > 0 && (() => {
        const resume = v.resumes.find((r) => r.id === selectedVersion)
          ?? v.resumes.find((r) => r.id === v.job.activeResumeVersionId) ?? v.resumes[0]!;
        return <div className="space-y-4">
          <label className="flex items-center gap-3 text-sm font-medium">
            Resume version
            <select value={resume.id} onChange={(e) => { setSelectedVersion(e.target.value); setMatchSummary("Loading requirement matches…"); }}
              className="rounded-lg border border-input bg-background p-2">
              {v.resumes.map((r) => <option key={r.id} value={r.id}>v{r.version} · {pretty(r.reviewState)}{r.id === v.job.activeResumeVersionId ? " · active" : ""}</option>)}
            </select>
          </label>
          <ResumeReview key={resume.id} versionId={resume.id} refreshToken={refreshToken}
            onChanged={onChanged} onReviewed={() => void refreshDetail()} onSummary={setMatchSummary} />
        </div>;
      })()}

    </section>
  );

  const renderNotesAndHistory = (v: JobDetailView) => (
    <div className="space-y-5">
      {/* Application Record */}
      {v.application !== null && (
        <section aria-labelledby="drawer-application" className="rounded-lg border border-emerald-300/60 bg-emerald-50/50 dark:bg-emerald-950/20 p-4 space-y-1">
          <h3 id="drawer-application" className="font-semibold text-sm text-emerald-900 dark:text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            <span>Application Recorded</span>
          </h3>
          <p className="text-xs text-foreground/80">
            Applied {v.application.appliedAt}
            {v.application.confirmationNumber !== null
              ? ` · confirmation ${v.application.confirmationNumber}`
              : ""}
          </p>
        </section>
      )}

      {/* Notes Section */}
      <section aria-labelledby="drawer-notes" className="rounded-lg border border-border/80 bg-card p-4 space-y-3">
        <h3 id="drawer-notes" className="font-bold text-base flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-primary" />
          <span>Notes ({v.notes.length})</span>
        </h3>

        {v.notes.length === 0 && (
          <p className="text-xs text-muted-foreground">No notes yet.</p>
        )}

        <ul className="space-y-2 text-xs">
          {v.notes.map((note) => (
            <li key={note.id} className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-1">
              <p className="whitespace-pre-wrap font-sans text-foreground">{note.body}</p>
              <span className="block text-[11px] text-muted-foreground">{note.createdAt}</span>
            </li>
          ))}
        </ul>

        <div className="pt-2 border-t border-border/60">
          <AddNoteForm
            jobId={v.job.id}
            onSaved={() => {
              onChanged();
              void refreshDetail();
            }}
          />
        </div>
      </section>

      {/* History Timeline */}
      <section aria-labelledby="drawer-history" className="rounded-lg border border-border/80 bg-card p-4 space-y-3">
        <h3 id="drawer-history" className="font-semibold text-sm flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <span>History ({v.history.length})</span>
        </h3>

        {v.history.length === 0 && (
          <p className="text-xs text-muted-foreground">No moves yet.</p>
        )}

        <ul className="space-y-2 text-xs">
          {v.history.map((event) => (
            <li key={event.id} className="rounded-md border border-border/60 bg-muted/20 p-2.5 space-y-1">
              <div className="flex items-center justify-between font-semibold">
                <span>{(event.fromStatus ?? "—") + " → " + event.toStatus}</span>
                <span className="text-[11px] text-muted-foreground">{event.createdAt}</span>
              </div>
              <p className="text-muted-foreground">
                {event.reason ?? "move"} · by {event.actor}
              </p>
              {event.metadata?.note !== undefined && event.metadata.note !== null && (
                <span className="block text-foreground bg-background p-1.5 rounded border border-border/40">
                  Note: {event.metadata.note}
                </span>
              )}
              {event.metadata?.reason !== undefined && event.metadata.reason !== null && (
                <span className="block text-foreground bg-background p-1.5 rounded border border-border/40">
                  Reason: {event.metadata.reason}
                </span>
              )}
              {event.metadata?.appliedAt !== undefined && (
                <span className="block text-emerald-700 dark:text-emerald-400">
                  Applied: {event.metadata.appliedAt}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* Fetch Attempts */}
      <section aria-labelledby="drawer-attempts" className="rounded-lg border border-border/80 bg-card p-4 space-y-2">
        <h3 id="drawer-attempts" className="font-semibold text-sm flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span>Fetch attempts ({v.attempts.length})</span>
        </h3>

        {v.attempts.length === 0 && (
          <p className="text-xs text-muted-foreground">No attempts recorded.</p>
        )}

        <ul className="text-xs space-y-2">
          {v.attempts.map((attempt) => (
            <li key={attempt.id} className="rounded border border-border/60 bg-muted/10 p-2 space-y-0.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{attempt.outcome}</span>
                <span className="text-muted-foreground">{attempt.startedAt}</span>
              </div>
              {attempt.reasonCode !== null && (
                <span className="block text-muted-foreground">Reason: {attempt.reasonCode}</span>
              )}
              {attempt.errorDetail !== null && (
                <span className="block text-destructive">Error: {attempt.errorDetail}</span>
              )}
            </li>
          ))}
        </ul>

        {v.artifacts.length > 0 && (
          <div className="pt-2 border-t border-border/60">
            <p className="text-xs font-semibold mb-1">Evidence Files</p>
            <ul className="text-xs space-y-1">
              {v.artifacts.map((artifact) => (
                <li key={artifact.id}>
                  <a href={`/api/evidence/${artifact.id}`} className="text-primary underline">
                    {artifact.kind} evidence
                  </a>{" "}
                  <span className="text-muted-foreground">({formatBytes(artifact.byteSize)})</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {v.intake !== null && (
        <p className="text-xs text-muted-foreground">
          From intake batch{" "}
          <a href={`/intake/batches/${v.intake.batchId}`} className="text-primary underline">
            line {v.intake.lineNumber}
          </a>
          .
        </p>
      )}
    </div>
  );

  return (
    <Dialog labelledBy="card-drawer-heading" onClose={onClose} position="workspace">
      <button type="button" aria-label="Close" onClick={onClose} className="mb-5 flex items-center gap-2 rounded-md px-2 py-1 text-sm font-medium hover:bg-muted">
        <ArrowLeft className="h-4 w-4" /> Back to Board
      </button>
      {view === null && <h2 id="card-drawer-heading" className="sr-only">Job workspace</h2>}
      {view === null && error === null && (
        <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground justify-center">
          <Sparkles className="h-5 w-5 animate-spin text-primary" />
          <span>Loading card details…</span>
        </div>
      )}

      {error !== null && (
        <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm font-semibold text-destructive">
          Could not load the card: {error}
        </div>
      )}

      {view !== null && (
        <div className="flex flex-col space-y-6">
          {/* Top Header & Breadcrumb */}
          <div className="border-b border-border/70 pb-4">

            <h2 id="card-drawer-heading" className="text-2xl font-bold tracking-tight text-foreground">
              {view.job.title ?? "Untitled posting"}
            </h2>

            <p className="mt-1 text-sm font-medium text-muted-foreground">
              {[view.job.company, view.job.location].filter((part) => part !== null && part !== "").join(" · ") ||
                "Unknown employer"}
            </p>

            {/* Semantic status line required by tests */}
            <p className="mt-2 text-xs text-muted-foreground">
              Status: {view.job.status} · Scrape: {pretty(view.job.scrapeState)}
              {view.job.scrapeReasonCode !== null ? ` (${pretty(view.job.scrapeReasonCode)})` : ""} ·
              Tailoring: {pretty(view.job.tailoringState)}
            </p>

            {/* Move & Correct Toolbar */}
            <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-border/60 bg-muted/20 p-3">
              {ORDINARY_TARGETS[view.job.status].length > 0 && (
                <div className="flex items-end gap-2">
                  <div>
                    <label htmlFor="drawer-move-to" className="block text-xs font-semibold text-muted-foreground mb-1">
                      Move to
                    </label>
                    <select
                      id="drawer-move-to"
                      value={moveTo}
                      onChange={(event) => setMoveTo(event.target.value as BoardStatus | "")}
                      className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
                    >
                      <option value="">Select…</option>
                      {ORDINARY_TARGETS[view.job.status].map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void onMoveSubmit(view)}
                    disabled={moveTo === ""}
                    className="h-8 font-semibold text-xs"
                  >
                    Move
                  </Button>
                </div>
              )}

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => { setActiveTab("notes"); onCorrect(asCard(view)); }}
                className="h-8 font-medium text-xs"
              >
                Correct / reopen
              </Button>
            </div>

            {actionError !== null && (
              <p role="alert" className="mt-2 text-xs font-semibold text-destructive">
                {actionError}
              </p>
            )}
            {retryNotice !== null && (
              <p className="mt-2 text-xs text-muted-foreground">{retryNotice}</p>
            )}
          </div>

          {renderTailoringAlert(view)}

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.85fr)_minmax(280px,1fr)]">
            <Tabs value={activeTab ?? (view.resumes.length > 0 ? "resumes" : "overview")} onValueChange={setActiveTab} className="min-w-0">
              <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 p-1">
                <TabsTrigger value="resumes">Tailoring & Resumes</TabsTrigger>
                <TabsTrigger value="overview">Job Description & Overview</TabsTrigger>
                <TabsTrigger value="notes">Notes & Timeline</TabsTrigger>
              </TabsList>
              <TabsContent value="resumes" className="workspace-tab mt-5">{renderResumes(view)}</TabsContent>
              <TabsContent value="overview" className="workspace-tab mt-5">{renderOverview(view)}</TabsContent>
              <TabsContent value="notes" className="workspace-tab mt-5">{renderNotesAndHistory(view)}</TabsContent>
            </Tabs>
            <aside aria-label="Job context" className="space-y-4 lg:sticky lg:top-6">
              <section className="rounded-xl border bg-card p-5">
                <h3 className="mb-4 font-semibold">Quick facts</h3>
                <dl className="space-y-3 text-sm">
                  {[["Arrangement", view.job.arrangement], ["Salary", view.job.salaryText], ["Posted", view.job.postedAt]].map(([label, value]) => (
                    <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words">{value ?? "Unknown"}</dd></div>
                  ))}
                  {view.intake && <div><dt className="text-xs text-muted-foreground">Batch origin</dt><dd><a className="underline" href={`/intake/batches/${view.intake.batchId}`}>Intake line {view.intake.lineNumber}</a></dd></div>}
                </dl>
              </section>
              <section className="rounded-xl border bg-card p-5">
                <h3 className="mb-2 font-semibold">Requirement matches</h3>
                <p className="text-sm text-muted-foreground">{matchSummary}</p>
                <p className="mt-2 text-xs text-muted-foreground">Evidence coverage, not a hiring prediction.</p>
              </section>
              <section className="rounded-xl border bg-card p-5 space-y-3">
                <h3 className="font-semibold">Application tracker</h3>
                {view.application ? <p className="text-sm">Applied {view.application.appliedAt}<br />Confirmation: {view.application.confirmationNumber ?? "None recorded"}</p>
                  : <p className="text-sm text-muted-foreground">No application recorded. Apply on the original site, then log the outcome here.</p>}
                {(view.source?.applyUrl ?? view.source?.submittedUrl) && <a className="block text-sm font-medium underline" href={view.source?.applyUrl ?? view.source?.submittedUrl ?? undefined} target="_blank" rel="noreferrer">Visit application site ↗</a>}
                {view.job.status === "TAILORED" && <Button type="button" onClick={() => onApplied(asCard(view), view.job.rank)}>Apply & Log</Button>}
              </section>
            </aside>
          </div>
        </div>
      )}
    </Dialog>
  );
}
