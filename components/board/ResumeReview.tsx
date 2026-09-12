"use client";

import { useCallback, useEffect, useState } from "react";
import type { ResumeReviewView } from "@/src/server/review";
import { apiGet, errorMessage } from "../api";
import { postJobMutation } from "./mutate";

/**
 * Side-by-side resume review for one immutable version: proposed changes
 * and claims next to requirements, evidence facts, and explicit gaps,
 * plus artifact preview/download and the human decision buttons.
 *
 * Every rendered string is untrusted provider/page content: React escapes
 * by default and nothing here is injected as markup. Approval is a
 * deliberate two-step gesture (open the confirmation, then confirm);
 * revision requires a written note. Both mutate through the job's
 * compare-and-swap version with one conflict retry.
 */

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function prettyState(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

interface ResumeReviewProps {
  versionId: string;
  /** Increment to force a re-read (e.g. after an outer refresh). */
  refreshToken: number;
  /** Board-level refresh: approval moves the card between columns. */
  onChanged: () => void;
  /** Card-detail refresh: version states and history changed. */
  onReviewed: () => void;
}

export default function ResumeReview({ versionId, refreshToken, onChanged, onReviewed }: ResumeReviewProps) {
  const [view, setView] = useState<ResumeReviewView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [approveNote, setApproveNote] = useState("");
  const [reviseNote, setReviseNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setView(await apiGet<ResumeReviewView>(`/api/resumes/${versionId}/review`));
      setLoadError(null);
    } catch (fetchError: unknown) {
      setLoadError(errorMessage(fetchError));
    }
  }, [versionId]);

  useEffect(() => {
    // Fetch-on-mount/refresh only; load sets state after a network
    // round-trip, so this cannot cascade renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshToken]);

  async function afterMutation(message: string): Promise<void> {
    setNotice(message);
    setActionError(null);
    setConfirming(false);
    setApproveNote("");
    setReviseNote("");
    onChanged();
    onReviewed();
    await load();
  }

  async function onConfirmApprove(current: ResumeReviewView): Promise<void> {
    setBusy(true);
    try {
      await postJobMutation(`/api/jobs/${current.job.id}/resume/approve`, {
        resumeVersionId: current.version.id,
        observedRowVersion: current.job.rowVersion,
        note: approveNote.trim() === "" ? undefined : approveNote.trim(),
      });
      await afterMutation(`Version ${current.version.version} approved — the card moved to Tailored.`);
    } catch (approveError: unknown) {
      setActionError(errorMessage(approveError));
    } finally {
      setBusy(false);
    }
  }

  async function onRequestRevision(current: ResumeReviewView): Promise<void> {
    if (reviseNote.trim() === "") {
      setActionError("A revision request needs a note describing what is wrong.");
      return;
    }
    setBusy(true);
    try {
      await postJobMutation(`/api/jobs/${current.job.id}/resume/revise`, {
        resumeVersionId: current.version.id,
        observedRowVersion: current.job.rowVersion,
        note: reviseNote.trim(),
      });
      await afterMutation(
        `Revision requested for version ${current.version.version} — a new version is being generated.`,
      );
    } catch (reviseError: unknown) {
      setActionError(errorMessage(reviseError));
    } finally {
      setBusy(false);
    }
  }

  if (loadError !== null) {
    return (
      <p role="alert" className="mt-1">
        Could not load the review: {loadError}{" "}
        <button type="button" onClick={() => void load()} className="underline">
          Retry
        </button>
      </p>
    );
  }
  if (view === null) {
    return <p className="mt-1">Loading review…</p>;
  }

  const reviewHeadingId = `review-${view.version.id}-heading`;
  const approveNoteId = `review-${view.version.id}-approve-note`;
  const reviseNoteId = `review-${view.version.id}-revise-note`;

  return (
    <div aria-labelledby={reviewHeadingId} className="mt-1">
      <p id={reviewHeadingId} className="font-semibold">
        Version {view.version.version} · {prettyState(view.version.reviewState)}
        {view.version.parentVersionId !== null ? " · revises an earlier version" : " · first version"}
      </p>
      <p className="mt-1 text-xs">
        Template {view.version.templateId} {view.version.templateVersion} · ranker{" "}
        {view.version.rankerVersion} · policy {view.version.policyVersion} · config{" "}
        {view.version.configVersion} · content {shortHash(view.version.contentHash)}
      </p>

      {notice !== null && <p className="mt-2 font-semibold">{notice}</p>}
      {actionError !== null && (
        <p role="alert" className="mt-2 font-semibold">
          {actionError}
        </p>
      )}

      {view.actions.reason !== null && !view.actions.canApprove && !view.actions.canRequestRevision && (
        <p className="mt-2">{view.actions.reason}</p>
      )}

      {view.actions.canApprove && !confirming && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => {
              setActionError(null);
              setConfirming(true);
            }}
            disabled={busy}
            className="border px-3 py-1 font-semibold disabled:opacity-50"
          >
            Approve version {view.version.version}
          </button>
        </div>
      )}

      {view.actions.canApprove && confirming && (
        <div className="mt-3 border p-3">
          <p className="font-semibold">Confirm approval of version {view.version.version}</p>
          <p className="mt-1">
            This binds content {shortHash(view.version.contentHash)} and the{" "}
            {view.artifacts.length} stored artifacts, and moves the card to Tailored. The version
            becomes immutable.
          </p>
          <ul className="mt-1">
            {view.artifacts.map((artifact) => (
              <li key={artifact.id}>
                {artifact.kind} · {formatBytes(artifact.byteSize)} · {shortHash(artifact.sha256)}
              </li>
            ))}
          </ul>
          <label htmlFor={approveNoteId} className="mt-2 block font-semibold">
            Approval note (optional)
          </label>
          <textarea
            id={approveNoteId}
            value={approveNote}
            onChange={(event) => setApproveNote(event.target.value)}
            rows={2}
            maxLength={4000}
            className="mt-1 w-full border p-1"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => void onConfirmApprove(view)}
              disabled={busy}
              className="border px-3 py-1 font-semibold disabled:opacity-50"
            >
              Confirm approval
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setApproveNote("");
              }}
              disabled={busy}
              className="border px-3 py-1 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {view.actions.canRequestRevision && (
        <div className="mt-3">
          <label htmlFor={reviseNoteId} className="block font-semibold">
            Request revision
          </label>
          <textarea
            id={reviseNoteId}
            value={reviseNote}
            onChange={(event) => setReviseNote(event.target.value)}
            rows={2}
            maxLength={4000}
            placeholder="What is wrong with this version?"
            className="mt-1 w-full border p-1"
          />
          <button
            type="button"
            onClick={() => void onRequestRevision(view)}
            disabled={busy || reviseNote.trim() === ""}
            className="mt-1 border px-3 py-1 font-semibold disabled:opacity-50"
          >
            Request revision
          </button>
        </div>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <section aria-label="Proposed changes and claims">
          <h4 className="font-semibold">Proposed changes</h4>
          {view.content?.changeSummary === null || view.content?.changeSummary === undefined ? (
            <p className="mt-1">Change summary unavailable.</p>
          ) : (
            <div className="mt-1">
              <p>
                {view.content.changeSummary.addedBullets.length} added ·{" "}
                {view.content.changeSummary.removedBullets.length} removed · summary{" "}
                {view.content.changeSummary.summaryChanged ? "changed" : "unchanged"}
              </p>
              {view.content.changeSummary.addedBullets.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {view.content.changeSummary.addedBullets.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
              {view.content.changeSummary.removedBullets.length > 0 && (
                <div className="mt-1">
                  <p className="font-semibold">Removed</p>
                  <ul className="list-disc pl-5">
                    {view.content.changeSummary.removedBullets.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <h4 className="mt-3 font-semibold">Resume claims ({view.claims.length})</h4>
          {view.claims.length === 0 && <p className="mt-1">No claims recorded.</p>}
          <ul className="mt-1">
            {view.claims.map((claim) => (
              <li key={claim.id} className="mt-1 border-t pt-1">
                {claim.claimText}
                {claim.derivationKind !== null && (
                  <span className="block">Derived by rule: {claim.derivationKind}</span>
                )}
                {claim.facts.length > 0 && (
                  <ul className="list-disc pl-5">
                    {claim.facts.map((fact) => (
                      <li key={fact.factId}>
                        [{fact.factId}] {fact.statement}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Requirements, evidence, and gaps">
          <h4 className="font-semibold">
            Requirements ({view.analysis?.requirements.length ?? 0})
          </h4>
          {view.analysis === null && <p className="mt-1">Analysis unavailable.</p>}
          {view.analysis !== null && view.analysis.requirements.length === 0 && (
            <p className="mt-1">No requirements recorded.</p>
          )}
          <ul className="mt-1">
            {(view.analysis?.requirements ?? []).map((requirement) => (
              <li key={requirement.requirementId} className="mt-1 border-t pt-1">
                <span className="block">“{requirement.jdQuote}”</span>
                <span className="block">
                  {prettyState(requirement.importance)} · {prettyState(requirement.matchStatus)}
                </span>
                {requirement.evidenceFactIds.length > 0 && (
                  <span className="block">Evidence: {requirement.evidenceFactIds.join(", ")}</span>
                )}
              </li>
            ))}
          </ul>

          <h4 className="mt-3 font-semibold">Gaps — not on the resume ({view.analysis?.gaps.length ?? 0})</h4>
          <ul className="mt-1">
            {(view.analysis?.gaps ?? []).map((gap) => (
              <li key={gap.requirementId} className="mt-1 border-t pt-1">
                <span className="block">“{gap.jdQuote}”</span>
                <span className="block">
                  {prettyState(gap.importance)} · {prettyState(gap.matchStatus)}
                </span>
              </li>
            ))}
          </ul>
          {view.content !== null && view.content.omittedUnsupported.length > 0 && (
            <p className="mt-1">Omitted unsupported terms: {view.content.omittedUnsupported.join(", ")}</p>
          )}
        </section>
      </div>

      {view.content?.audit !== null && view.content?.audit !== undefined && (
        <section aria-label="Generation notes" className="mt-4">
          <h4 className="font-semibold">Generation notes</h4>
          <p className="mt-1">
            {view.content.audit.supportedCount} of {view.content.audit.requirementsTotal} requirements
            supported · {view.content.audit.gapCount} gaps · {view.content.audit.validatedClaims} of{" "}
            {view.content.audit.totalClaims} claims validated
            {view.analysis?.provider !== null && view.analysis?.provider !== undefined
              ? ` · via ${view.analysis.provider}`
              : ""}
          </p>
          <p className="mt-1">{view.content.audit.rationale}</p>
          {view.content.audit.questions.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {view.content.audit.questions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section aria-label="Resume files" className="mt-4">
        <h4 className="font-semibold">Files ({view.artifacts.length})</h4>
        {view.artifacts.length === 0 && <p className="mt-1">No files published yet.</p>}
        <ul className="mt-1">
          {view.artifacts.map((artifact) => (
            <li key={artifact.id}>
              {artifact.kind} ({formatBytes(artifact.byteSize)}) ·{" "}
              <a
                href={`/api/resumes/artifacts/${artifact.id}`}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Preview
              </a>{" "}
              ·{" "}
              <a href={`/api/resumes/artifacts/${artifact.id}?download=1`} className="underline">
                Download
              </a>
            </li>
          ))}
        </ul>
      </section>

      {view.reviews.length > 0 && (
        <section aria-label="Review history" className="mt-4">
          <h4 className="font-semibold">Review history ({view.reviews.length})</h4>
          <ul className="mt-1">
            {view.reviews.map((review) => (
              <li key={review.id}>
                {prettyState(review.action)} by {review.actor} · {review.createdAt}
                {review.note !== null ? ` — ${review.note}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
