"use client";

import { useCallback, useEffect, useState } from "react";
import type { BoardStatus } from "@/src/domain/enums";
import type { BoardCardView, JobDetailView } from "@/src/server/board";
import { apiGet, errorMessage } from "../api";
import AddNoteForm from "./AddNoteForm";
import Dialog from "./dialog";
import { postJobMutation } from "./mutate";

/**
 * Card detail drawer: facts, source links, attempts, missing fields,
 * resumes, notes, the application record, workflow history, and intake
 * provenance — plus the keyboard-operable action path (move menu,
 * correction, application recording) that mirrors drag and drop.
 *
 * All rendered strings are untrusted page/user content: React escapes by
 * default and only the API-validated URL fields become link targets.
 */

// Ordinary drag targets per status (mirrors the R1-C graph for affordance;
// the server re-validates every move).
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

interface CardDrawerProps {
  jobId: string;
  /** Increment to force a detail re-read (e.g. after a dialog saved). */
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
  return (
    <Dialog labelledBy="card-drawer-heading" onClose={onClose} position="right">
      {view === null && error === null && <p>Loading card…</p>}
      {error !== null && (
        <p role="alert" className="font-semibold">
          Could not load the card: {error}
        </p>
      )}
      {view !== null && (
        <div>
          <h2 id="card-drawer-heading" className="text-2xl font-semibold">
            {view.job.title ?? "Untitled posting"}
          </h2>
          <p className="mt-1">
            {[view.job.company, view.job.location].filter((part) => part !== null && part !== "").join(" · ") ||
              "Unknown employer"}
          </p>
          <p className="mt-1 text-sm">
            Status: {view.job.status} · Scrape: {pretty(view.job.scrapeState)}
            {view.job.scrapeReasonCode !== null ? ` (${pretty(view.job.scrapeReasonCode)})` : ""} ·
            Tailoring: {pretty(view.job.tailoringState)}
          </p>

          <div className="mt-3 flex flex-wrap items-end gap-3">
            {ORDINARY_TARGETS[view.job.status].length > 0 && (
              <div>
                <label htmlFor="drawer-move-to" className="block text-sm font-semibold">
                  Move to
                </label>
                <select
                  id="drawer-move-to"
                  value={moveTo}
                  onChange={(event) => setMoveTo(event.target.value as BoardStatus | "")}
                  className="mt-1 border bg-white p-1"
                >
                  <option value="">Select…</option>
                  {ORDINARY_TARGETS[view.job.status].map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>{" "}
                <button
                  type="button"
                  onClick={() => void onMoveSubmit(view)}
                  disabled={moveTo === ""}
                  className="border px-3 py-1 font-semibold disabled:opacity-50"
                >
                  Move
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => onCorrect(asCard(view))}
              className="border px-3 py-1 font-semibold"
            >
              Correct / reopen
            </button>
          </div>
          {actionError !== null && (
            <p role="alert" className="mt-2 font-semibold">
              {actionError}
            </p>
          )}

          <section aria-labelledby="drawer-facts" className="mt-5">
            <h3 id="drawer-facts" className="font-semibold">
              Facts
            </h3>
            <dl className="mt-1 text-sm">
              <dt className="font-semibold">Arrangement</dt>
              <dd>{view.job.arrangement ?? "Unknown"}</dd>
              <dt className="mt-1 font-semibold">Salary</dt>
              <dd>{view.job.salaryText ?? "Unknown"}</dd>
              <dt className="mt-1 font-semibold">Posted</dt>
              <dd>{view.job.postedAt ?? "Unknown"}</dd>
              <dt className="mt-1 font-semibold">Description</dt>
              <dd className="whitespace-pre-wrap">{view.job.descriptionText ?? "Unknown"}</dd>
            </dl>
          </section>

          {view.source !== null && (
            <section aria-labelledby="drawer-source" className="mt-5">
              <h3 id="drawer-source" className="font-semibold">
                Source
              </h3>
              <ul className="mt-1 text-sm">
                {(
                  [
                    ["Submitted", view.source.submittedUrl],
                    ["Canonical", view.source.canonicalUrl],
                    ["Fetched", view.source.finalUrl],
                    ["Apply", view.source.applyUrl],
                  ] as const
                ).map(
                  ([label, url]) =>
                    url !== null && (
                      <li key={label}>
                        {label}:{" "}
                        <a href={url} target="_blank" rel="noreferrer" className="underline">
                          Open original
                        </a>
                      </li>
                    ),
                )}
              </ul>
            </section>
          )}

          <section aria-labelledby="drawer-attempts" className="mt-5">
            <h3 id="drawer-attempts" className="font-semibold">
              Fetch attempts ({view.attempts.length})
            </h3>
            {view.attempts.length === 0 && <p className="mt-1 text-sm">No attempts recorded.</p>}
            <ul className="mt-1 text-sm">
              {view.attempts.map((attempt) => (
                <li key={attempt.id} className="mt-1 border-t pt-1">
                  {attempt.outcome}
                  {attempt.reasonCode !== null ? ` (${attempt.reasonCode})` : ""}
                  {attempt.errorDetail !== null ? ` — ${attempt.errorDetail}` : ""}
                  <span className="block">
                    via {attempt.workerId ?? "unknown worker"} · {attempt.startedAt}
                  </span>
                </li>
              ))}
            </ul>
            {view.artifacts.length > 0 && (
              <ul className="mt-2 text-sm">
                {view.artifacts.map((artifact) => (
                  <li key={artifact.id}>
                    <a href={`/api/evidence/${artifact.id}`} className="underline">
                      {artifact.kind} evidence
                    </a>{" "}
                    ({formatBytes(artifact.byteSize)})
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="drawer-extraction" className="mt-5">
            <h3 id="drawer-extraction" className="font-semibold">
              Extraction
            </h3>
            {view.extraction === null ? (
              <p className="mt-1 text-sm">No extraction yet.</p>
            ) : (
              <div className="mt-1 text-sm">
                <p>
                  {view.extraction.adapter}
                  {view.extraction.confidence !== null
                    ? ` · confidence ${view.extraction.confidence}`
                    : ""}
                </p>
                {view.extraction.missingFields.length > 0 ? (
                  <p>Missing: {view.extraction.missingFields.join(", ")}</p>
                ) : (
                  <p>Nothing missing.</p>
                )}
              </div>
            )}
          </section>

          <section aria-labelledby="drawer-resumes" className="mt-5">
            <h3 id="drawer-resumes" className="font-semibold">
              Resumes ({view.resumes.length})
            </h3>
            {view.resumes.length === 0 && (
              <p className="mt-1 text-sm">No tailored resume yet.</p>
            )}
            {view.resumes.map((resume) => (
              <div key={resume.id} className="mt-2 border-t pt-1 text-sm">
                <p className="font-semibold">
                  Version {resume.version} · {pretty(resume.reviewState)}
                </p>
                {resume.artifacts.length > 0 && (
                  <p>
                    Files:{" "}
                    {resume.artifacts.map((file) => `${file.kind} (${formatBytes(file.byteSize)})`).join(", ")}
                    {" "}(downloads arrive with resume review)
                  </p>
                )}
                {resume.reviews.map((review) => (
                  <p key={review.id}>
                    {review.action} by {review.actor} · {review.createdAt}
                    {review.note !== null ? ` — ${review.note}` : ""}
                  </p>
                ))}
              </div>
            ))}
          </section>

          <section aria-labelledby="drawer-notes" className="mt-5">
            <h3 id="drawer-notes" className="font-semibold">
              Notes ({view.notes.length})
            </h3>
            {view.notes.length === 0 && <p className="mt-1 text-sm">No notes yet.</p>}
            <ul className="mt-1 text-sm">
              {view.notes.map((note) => (
                <li key={note.id} className="mt-1 border-t pt-1">
                  <span className="whitespace-pre-wrap">{note.body}</span>
                  <span className="block">{note.createdAt}</span>
                </li>
              ))}
            </ul>
            <AddNoteForm
              jobId={view.job.id}
              onSaved={() => {
                onChanged();
                void refreshDetail();
              }}
            />
          </section>

          {view.application !== null && (
            <section aria-labelledby="drawer-application" className="mt-5">
              <h3 id="drawer-application" className="font-semibold">
                Application
              </h3>
              <p className="mt-1 text-sm">
                Applied {view.application.appliedAt}
                {view.application.confirmationNumber !== null
                  ? ` · confirmation ${view.application.confirmationNumber}`
                  : ""}
              </p>
            </section>
          )}

          <section aria-labelledby="drawer-history" className="mt-5">
            <h3 id="drawer-history" className="font-semibold">
              History ({view.history.length})
            </h3>
            {view.history.length === 0 && <p className="mt-1 text-sm">No moves yet.</p>}
            <ul className="mt-1 text-sm">
              {view.history.map((event) => (
                <li key={event.id} className="mt-1 border-t pt-1">
                  {(event.fromStatus ?? "—") + " → " + event.toStatus} · {event.reason ?? "move"} ·{" "}
                  {event.actor} · {event.createdAt}
                  {event.metadata?.note !== undefined && event.metadata.note !== null && (
                    <span className="block">Note: {event.metadata.note}</span>
                  )}
                  {event.metadata?.reason !== undefined && event.metadata.reason !== null && (
                    <span className="block">Reason: {event.metadata.reason}</span>
                  )}
                  {event.metadata?.appliedAt !== undefined && (
                    <span className="block">Applied: {event.metadata.appliedAt}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {view.intake !== null && (
            <p className="mt-5 text-sm">
              From intake batch{" "}
              <a href={`/intake/batches/${view.intake.batchId}`} className="underline">
                line {view.intake.lineNumber}
              </a>
              .
            </p>
          )}

          <button type="button" onClick={onClose} className="mt-6 border px-4 py-2 font-semibold">
            Close
          </button>
        </div>
      )}
    </Dialog>
  );
}
