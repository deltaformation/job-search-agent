"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  FileCheck,
  FileText,
  History,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { ResumeReviewView } from "@/src/server/review";
import { apiGet, errorMessage } from "../api";
import { postJobMutation } from "./mutate";

/**
 * Side-by-side resume review for one immutable version: proposed changes
 * and claims next to requirements, evidence facts, and explicit gaps,
 * plus artifact preview/download and the human decision buttons.
 */

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
  refreshToken: number;
  onChanged: () => void;
  onReviewed: () => void;
  onSummary?: (summary: string) => void;
}

export default function ResumeReview({
  versionId,
  refreshToken,
  onChanged,
  onReviewed,
  onSummary,
}: ResumeReviewProps) {
  const [view, setView] = useState<ResumeReviewView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [approveNote, setApproveNote] = useState("");
  const [reviseNote, setReviseNote] = useState("");
  const [busy, setBusy] = useState(false);
  const confirmPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The approve trigger lives in the sticky bar, which is visible
    // mid-document; when the inline confirmation opens, bring it into
    // view so the state change is never silent. Instant under reduced
    // motion; guarded for non-DOM test environments.
    if (!confirming) {
      return;
    }
    const panel = confirmPanelRef.current;
    if (panel !== null && typeof panel.scrollIntoView === "function") {
      const reduceMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      panel.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
    }
  }, [confirming]);

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await apiGet<ResumeReviewView>(`/api/resumes/${versionId}/review`);
      setView(result);
      const requirements = result.analysis?.requirements;
      const gapIds = new Set([
        ...(result.analysis?.gaps ?? []).map((r) => r.requirementId),
        ...(requirements ?? []).filter((r) => r.matchStatus === "gap" || r.matchStatus === "unsupported").map((r) => r.requirementId),
      ]);
      onSummary?.(requirements ? `${requirements.filter((r) => r.matchStatus === "matched").length} supported · ${requirements.filter((r) => r.matchStatus === "partial").length} partial · ${gapIds.size} gaps` : "Analysis unavailable.");
      setLoadError(null);
    } catch (fetchError: unknown) {
      setLoadError(errorMessage(fetchError));
    }
  }, [versionId, onSummary]);

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
      <div role="alert" className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm">
        <p className="font-semibold text-destructive">Could not load the review: {loadError}</p>
        <Button variant="outline" size="sm" onClick={() => void load()} className="mt-2">
          Retry
        </Button>
      </div>
    );
  }

  if (view === null) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Sparkles className="size-4 animate-spin text-primary" aria-hidden="true" />
        <span>Loading review…</span>
      </div>
    );
  }

  const reviewHeadingId = `review-${view.version.id}-heading`;
  const approveNoteId = `review-${view.version.id}-approve-note`;
  const reviseNoteId = `review-${view.version.id}-revise-note`;

  return (
    <div aria-labelledby={reviewHeadingId} className="resume-review space-y-6 pt-2">
      {/* Version Header Card */}
      <div className="rounded-lg border border-border/80 bg-muted/30 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileCheck className="size-5 text-primary" aria-hidden="true" />
            <h3 id={reviewHeadingId} className="text-base font-semibold tracking-tight">
              Version {view.version.version} · {prettyState(view.version.reviewState)}
            </h3>
            {view.version.parentVersionId !== null ? (
              <Badge variant="outline" className="text-xs">
                revises an earlier version
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-xs">
                first version
              </Badge>
            )}
          </div>
        </div>

        {notice !== null && (
          <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            {notice}
          </div>
        )}

        {actionError !== null && (
          <div role="alert" className="mt-3 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm font-semibold text-destructive">
            {actionError}
          </div>
        )}

        {view.actions.reason !== null && !view.actions.canApprove && !view.actions.canRequestRevision && (
          <p className="mt-2 text-xs text-muted-foreground">{view.actions.reason}</p>
        )}


      </div>

      {/* Files & Artifacts */}
      <div className="rounded-lg border border-border/80 bg-card p-4 space-y-3">
        <h4 className="text-sm font-semibold flex items-center gap-2">
          <FileText className="size-4 text-primary" aria-hidden="true" />
          <span>Files ({view.artifacts.length})</span>
        </h4>
        {view.artifacts.length === 0 && (
          <p className="text-xs text-muted-foreground">No files published yet.</p>
        )}
        <div className="flex flex-wrap gap-2">
          {view.artifacts.map((artifact) => (
            <div
              key={artifact.id}
              className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs"
            >
              <span className="font-semibold uppercase text-[11px]">{artifact.kind}</span>
              <span className="text-muted-foreground font-mono tabular-nums">({formatBytes(artifact.byteSize)})</span>
              <span className="text-border">|</span>
              <a
                href={`/api/resumes/artifacts/${artifact.id}`}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline font-medium"
              >
                Preview
              </a>
              <a
                href={`/api/resumes/artifacts/${artifact.id}?download=1`}
                className="text-primary underline font-medium"
              >
                Download
              </a>
            </div>
          ))}
        </div>
      </div>

      {/* Side-by-Side: Proposed Changes & Claims vs Requirements & Gaps */}
      <div className="grid gap-5 xl:grid-cols-2">
        {/* Left: Proposed Changes & Resume Claims */}
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center justify-between">
              <span>Proposed changes</span>
              {view.content?.changeSummary && (
                <span className="text-xs font-normal text-muted-foreground">
                  +{view.content.changeSummary.addedBullets.length} / -
                  {view.content.changeSummary.removedBullets.length}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed">
            {view.content?.changeSummary === null || view.content?.changeSummary === undefined ? (
              <p className="text-muted-foreground">Change summary unavailable.</p>
            ) : (
              <div>
                <p className="font-medium text-foreground">
                  {view.content.changeSummary.addedBullets.length} added ·{" "}
                  {view.content.changeSummary.removedBullets.length} removed · summary{" "}
                  {view.content.changeSummary.summaryChanged ? "changed" : "unchanged"}
                </p>
                {view.content.changeSummary.addedBullets.length > 0 && (
                  <ul className="mt-2 space-y-1 pl-4 list-disc text-emerald-800 dark:text-emerald-300">
                    {view.content.changeSummary.addedBullets.map((line, idx) => (
                      <li key={`${line}-${idx}`}>{line}</li>
                    ))}
                  </ul>
                )}
                {view.content.changeSummary.removedBullets.length > 0 && (
                  <div className="mt-2">
                    <p className="font-semibold text-muted-foreground">Removed</p>
                    <ul className="mt-1 space-y-1 pl-4 list-disc text-destructive line-through">
                      {view.content.changeSummary.removedBullets.map((line, idx) => (
                        <li key={`${line}-${idx}`}>{line}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <Separator />

            <div>
              <h4 className="font-semibold text-sm mb-2">
                Resume claims ({view.claims.length})
              </h4>
              {view.claims.length === 0 && (
                <p className="text-muted-foreground">No claims recorded.</p>
              )}
              <ul className="space-y-2.5">
                {view.claims.map((claim) => (
                  <li key={claim.id} className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-2">
                    <p className="font-medium text-foreground">{claim.claimText}</p>
                    {claim.derivationKind !== null && (
                      <span className="inline-block text-[11px] text-muted-foreground">
                        Derived by rule: {claim.derivationKind}
                      </span>
                    )}
                    {claim.facts.length > 0 && (
                      <details open className="mt-2">
                        <summary className="cursor-pointer text-xs font-medium">Source facts ({claim.facts.length})</summary>
                      <ul className="mt-1 pl-3 border-l-2 border-primary/30 space-y-0.5 text-[11px] text-muted-foreground">
                        {claim.facts.map((fact) => (
                          <li key={fact.factId}>
                            <span className="font-mono tabular-nums">[{fact.factId}]</span> {fact.statement}
                          </li>
                        ))}
                      </ul>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>

        {/* Right: Requirements & Explicit Gaps */}
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center justify-between">
              <span>Requirements ({view.analysis?.requirements.length ?? 0})</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed">
            {view.analysis === null && <p className="text-muted-foreground">Analysis unavailable.</p>}
            {view.analysis !== null && view.analysis.requirements.length === 0 && (
              <p className="text-muted-foreground">No requirements recorded.</p>
            )}

            <ul className="space-y-2.5">
              {(view.analysis?.requirements ?? []).map((requirement) => (
                <li key={requirement.requirementId} className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-2">
                  <p className="font-medium text-foreground italic">“{requirement.jdQuote}”</p>
                  <div className="flex items-center gap-2 pt-0.5">
                    <Badge variant="outline" className="text-[11px]">
                      {prettyState(requirement.importance)}
                    </Badge>
                    <Badge
                      variant={
                        requirement.matchStatus === "matched"
                          ? "success"
                          : requirement.matchStatus === "partial"
                          ? "warning"
                          : "muted"
                      }
                      className="text-[11px]"
                    >
                      {requirement.matchStatus === "matched" ? "Supported" : prettyState(requirement.matchStatus)}
                    </Badge>
                  </div>
                  {requirement.evidenceFactIds.length > 0 && (
                    <p className="font-mono tabular-nums text-[11px] text-muted-foreground pt-0.5">
                      Evidence: {requirement.evidenceFactIds.join(", ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>

            <Separator />

            <div>
              <h4 className="font-semibold text-sm mb-2 text-destructive">
                Gaps — not on the resume ({view.analysis?.gaps.length ?? 0})
              </h4>
              <ul className="space-y-2">
                {(view.analysis?.gaps ?? []).map((gap) => (
                  <li key={gap.requirementId} className="rounded-md border border-destructive/20 bg-destructive/5 p-2 space-y-1">
                    <p className="font-medium text-destructive italic">“{gap.jdQuote}”</p>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className="text-[11px]">
                        {prettyState(gap.importance)}
                      </Badge>
                      <Badge variant="destructive" className="text-[11px]">
                        {prettyState(gap.matchStatus)}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ul>
              {view.content !== null && view.content.omittedUnsupported.length > 0 && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Omitted unsupported terms: {view.content.omittedUnsupported.join(", ")}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Top 5 ATS Keywords & Match Audit */}
      {view.topKeywords.length > 0 && (
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Sparkles className="size-4 text-primary" aria-hidden="true" />
              <span>Top 5 ATS keywords & match audit</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2.5 text-sm">
              {view.topKeywords.map((entry, index) => (
                <li key={`${entry.requirementId}-${entry.keyword}-${index}`} className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-2">
                  <p className="font-medium text-foreground italic">“{entry.keyword}”</p>
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <Badge variant="outline" className="text-[11px]">
                      {prettyState(entry.category)}
                    </Badge>
                    <Badge variant="outline" className="text-[11px]">
                      {prettyState(entry.importance)}
                    </Badge>
                    {entry.evidenced ? (
                      <Badge variant="success" className="text-[11px]">
                        Evidenced
                      </Badge>
                    ) : (
                      <Badge variant="destructive" className="text-[11px]">
                        Gap — not on resume
                      </Badge>
                    )}
                  </div>
                  {entry.evidenced ? (
                    <p className="text-[11px] text-muted-foreground pt-0.5">
                      {entry.placements.length > 0
                        ? `Woven into: ${entry.placements.map((placement) => placement.charAt(0).toUpperCase() + placement.slice(1)).join(", ")}`
                        : "Evidenced by facts but not literally woven into a section"}
                      {entry.evidenceFactIds.length > 0
                        ? ` · facts: ${entry.evidenceFactIds.join(", ")}`
                        : ""}
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground pt-0.5">
                      No supporting candidate facts — honestly omitted from the resume.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Generation Notes Card */}
      {view.content?.audit !== null && view.content?.audit !== undefined && (
        <Card className="shadow-sm bg-muted/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Sparkles className="size-4 text-primary" aria-hidden="true" />
              <span>Generation notes</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs space-y-2">
            <p className="font-medium">
              {view.content.audit.supportedCount} of {view.content.audit.requirementsTotal} requirements
              supported · {view.content.audit.gapCount} gaps · {view.content.audit.validatedClaims} of{" "}
              {view.content.audit.totalClaims} claims validated
              {view.analysis?.provider !== null && view.analysis?.provider !== undefined
                ? ` · via ${view.analysis.provider}`
                : ""}
            </p>
            <p className="text-muted-foreground leading-relaxed">{view.content.audit.rationale}</p>
            {view.content.audit.questions.length > 0 && (
              <ul className="list-disc pl-4 space-y-1 text-muted-foreground">
                {view.content.audit.questions.map((question, idx) => (
                  <li key={`${question}-${idx}`}>{question}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* Decision details flow inline at the end of the audit; only the
          compact trigger bar below sticks, so long confirmations can never
          push the actions offscreen or cover the content being reviewed. */}
      <div className="space-y-3">
      <section aria-label="Human review decision" className="rounded-xl border border-primary/20 bg-muted/30 p-5">
        <h4 className="font-semibold">Your review decision</h4>
        <p className="text-sm text-muted-foreground">Review the claims, evidence and files before approving this exact version.</p>

        {/* Confirmation Details Area */}
        {view.actions.canApprove && confirming && (
          <div ref={confirmPanelRef} className="workspace-tab mt-4 scroll-mt-24 rounded-lg border border-emerald-300/60 bg-emerald-50/60 dark:bg-emerald-950/30 p-4 space-y-3">
            <div className="flex items-center gap-2 text-emerald-900 dark:text-emerald-300">
              <CheckCircle2 className="size-5" aria-hidden="true" />
              <h4 className="font-bold text-sm">
                Confirm approval of version {view.version.version}
              </h4>
            </div>

            <p className="text-xs text-muted-foreground">
              This approves version {view.version.version} with {view.artifacts.length} stored files, and moves the card to Tailored. The version becomes immutable.
            </p>

            <ul className="rounded-md border border-border/60 bg-background/80 p-2 text-xs divide-y divide-border/40">
              {view.artifacts.map((artifact) => (
                <li key={artifact.id} className="py-1 flex items-center justify-between font-mono tabular-nums">
                  <span>{artifact.kind}</span>
                  <span className="text-muted-foreground">
                    {formatBytes(artifact.byteSize)}
                  </span>
                </li>
              ))}
            </ul>

            <div>
              <label htmlFor={approveNoteId} className="block text-xs font-semibold text-foreground mb-1">
                Approval note (optional)
              </label>
              <textarea
                id={approveNoteId}
                value={approveNote}
                onChange={(event) => setApproveNote(event.target.value)}
                rows={2}
                maxLength={4000}
                placeholder="Add an optional note documenting reasons for approval…"
                className="w-full rounded-md border border-input bg-background p-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Button
                type="button"
                onClick={() => void onConfirmApprove(view)}
                disabled={busy}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
              >
                Confirm approval
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setConfirming(false);
                  setApproveNote("");
                }}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Request Revision Form */}
        {view.actions.canRequestRevision && (
          <div className="mt-4 border-t border-border/60 pt-3">
            <label htmlFor={reviseNoteId} className="block text-xs font-semibold text-foreground mb-1">
              Request revision
            </label>
            <textarea
              id={reviseNoteId}
              value={reviseNote}
              onChange={(event) => setReviseNote(event.target.value)}
              rows={2}
              maxLength={4000}
              placeholder="What is wrong with this version?"
              className="w-full rounded-md border border-input bg-background p-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void onRequestRevision(view)}
              disabled={busy || reviseNote.trim() === ""}
              className="mt-2 gap-1.5"
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              Request revision
            </Button>
          </div>
        )}
      </section>

      {/* Compact sticky trigger bar: the primary decision stays reachable
          while reading, without covering the audit it governs. */}
      {view.actions.canApprove && !confirming && (
        <div className="sticky bottom-0 z-10 flex items-center justify-end gap-3 rounded-xl border border-border/80 bg-background p-3 shadow-sm">
          <p className="mr-auto hidden text-xs text-muted-foreground sm:block">
            Version {view.version.version} ·{" "}
            <span className="font-mono tabular-nums">{view.artifacts.length}</span>{" "}
            {view.artifacts.length === 1 ? "file" : "files"}
          </p>
          <Button
            type="button"
            onClick={() => {
              setActionError(null);
              setConfirming(true);
            }}
            disabled={busy}
            className="w-full gap-1.5 font-semibold bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm sm:w-auto"
          >
            <CheckCircle2 className="size-4" aria-hidden="true" />
            Approve version {view.version.version}
          </Button>
        </div>
      )}
      </div>

      {/* Review History */}
      {view.reviews.length > 0 && (
        <div className="rounded-lg border border-border/80 bg-card p-4 space-y-2">
          <h4 className="text-sm font-semibold flex items-center gap-2">
            <History className="size-4 text-muted-foreground" aria-hidden="true" />
            <span>Review history ({view.reviews.length})</span>
          </h4>
          <ul className="text-xs divide-y divide-border/60">
            {view.reviews.map((review) => (
              <li key={review.id} className="py-2">
                <span className="font-semibold text-foreground">{prettyState(review.action)}</span>{" "}
                <span className="text-muted-foreground">by {review.actor} · <span className="font-mono tabular-nums">{review.createdAt}</span></span>
                {review.note !== null && (
                  <p className="mt-1 text-muted-foreground bg-muted/50 rounded p-2">
                    {review.note}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
