"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, ExternalLink, FileText, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { JobDetailView } from "@/src/server/board";
import type { ResumeReviewView } from "@/src/server/review";
import type { VersionSummary } from "@/src/server/tailoringWorkspace";
import { assessmentDelta, assessmentPercent } from "@/src/domain/assessment";
import { buildWorkspaceETag } from "@/src/domain/tailoringWorkspace";
import type { WorkspaceView } from "@/src/domain/tailoringWorkspace";
import type { WorkspaceViewV2 } from "@/src/domain/step2";
import { STEP2_CORRECTION_VERSIONS } from "@/src/domain/step2Correction";
import type { WorkspaceViewV3 } from "@/src/domain/step2Correction";
import type { PreparationStatusV1 as PreparationStatus } from "@/src/domain/step2";
import type {
  WorkflowReviewInsight,
  WorkflowReviewV2,
} from "@/src/domain/workflowReview";
import type { AssessmentMeasureV1, MeasureSide } from "@/src/domain/tailoringWorkspace";
import type { StepNumber } from "./StepIndicator";
import Step4Diff from "./Step4Diff";

/**
 * Production Step 4 exact-version review (WO-1.3-G): version
 * selector, frozen summary, individual assessment measures (never
 * a composite score), provenance-aware insights, the exact review
 * gate, master-versus-tailored diff, full canonical content, exact
 * PDF preview, and the approve / decline / request-changes /
 * new-version flows. All reads are GETs; viewing or cancelling
 * writes nothing. Decisions POST with the fresh job CAS and reload
 * so every surface re-resolves from committed state.
 */

type WorkspaceAny = WorkspaceView | WorkspaceViewV2 | WorkspaceViewV3 | null;

interface ParsedApiError {
  status: number;
  code: string;
  message: string;
  currentRowVersion?: number;
}

async function parseApiError(response: Response): Promise<ParsedApiError> {
  const status = response.status;
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const code =
    (typeof body["error"] === "string" && body["error"]) ||
    (typeof body["code"] === "string" && body["code"]) ||
    `HTTP_${status}`;
  const message =
    (typeof body["reason"] === "string" && body["reason"]) ||
    (typeof body["message"] === "string" && body["message"]) ||
    (typeof body["detail"] === "string" && body["detail"]) ||
    "The server refused the request.";
  const currentRowVersion =
    typeof body["currentRowVersion"] === "number" ? body["currentRowVersion"] : undefined;
  return { status, code, message, currentRowVersion };
}

function measureSideLabel(side: MeasureSide): string {
  if (side.status === "assessed") {
    const percent = assessmentPercent(side);
    return `${side.numerator} of ${side.denominator} (${percent}%)`;
  }
  switch (side.reason) {
    case "NO_ELIGIBLE_ITEMS":
      return "Not assessed — no eligible items";
    case "BASELINE_UNAVAILABLE":
      return "Not assessed — baseline unavailable";
    case "CHECK_NOT_APPLICABLE":
      return "Not assessed — check not applicable";
    default:
      return `Not assessed — ${side.reason}`;
  }
}

const MEASURE_TITLES: Record<AssessmentMeasureV1["key"], { title: string; hint: string }> = {
  selected_keywords: {
    title: "Keyword matches",
    hint: "Frozen priority phrases present in each text",
  },
  supported_requirements: {
    title: "Supported requirements",
    hint: "Supported requirements linked to verified resume claims",
  },
  document_checks: {
    title: "Document checks",
    hint: "Content, contact, page budget, cross-format parity",
  },
  evidence_integrity: {
    title: "Evidence integrity",
    hint: "Cited facts present and approved in the frozen snapshot",
  },
};

const INSIGHT_KIND_LABEL: Record<WorkflowReviewInsight["kind"], string> = {
  "keyword-coverage": "Keywords",
  "requirement-coverage": "Requirements",
  "document-checks": "Checks",
  "evidence-integrity": "Evidence",
  "requirement-gap": "Gap",
  "provenance-note": "Provenance",
  "length-advisory": "Length (advisory)",
};

const PROVENANCE_BADGE: Record<string, string> = {
  VERIFIED_SOURCE: "Verified source",
  USER_ACCEPTED_AI: "AI-accepted",
  USER_EDITED: "User edit",
  UNLABELED: "Previous format",
};

function MeasureCard({ measure }: { measure: AssessmentMeasureV1 }) {
  const meta = MEASURE_TITLES[measure.key];
  const delta =
    measure.key === "selected_keywords"
      ? assessmentDelta(measure.original, measure.tailored)
      : null;
  return (
    <div className="rounded-lg border border-border/60 bg-card p-3">
      <p className="text-xs font-semibold">{meta.title}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{meta.hint}</p>
      <dl className="mt-2 space-y-1 text-xs">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-muted-foreground">Tailored</dt>
          <dd className="font-mono font-semibold">{measureSideLabel(measure.tailored)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-muted-foreground">Master</dt>
          <dd className="font-mono">{measureSideLabel(measure.original)}</dd>
        </div>
        {delta !== null && (
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">Change</dt>
            <dd className="font-mono font-semibold">
              {delta >= 0 ? "+" : ""}
              {delta} points
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function useReviewVersion(versionId: string | null) {
  const [view, setView] = useState<ResumeReviewView | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setState("loading");
    setError(null);
    try {
      const response = await fetch(`/api/resumes/${id}/review`);
      if (!response.ok) {
        const parsed = await parseApiError(response);
        setState("error");
        setError(
          response.status === 404
            ? "This resume version does not exist."
            : `Review failed to load (${parsed.code}). ${parsed.message}`,
        );
        setView(null);
        return;
      }
      const body = (await response.json()) as ResumeReviewView;
      setView(body);
      setState("idle");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : String(err));
      setView(null);
    }
  }, []);

  useEffect(() => {
    if (versionId !== null) {
      // Selection change refetches the exact-version review; the
      // else branch drops a stale review when selection clears.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void load(versionId);
    } else {
      setView(null);
      setState("idle");
    }
  }, [versionId, load]);

  return { view, state, error, reload: versionId === null ? null : () => load(versionId) };
}

function formatState(state: string): string {
  return state
    .toLowerCase()
    .split("_")
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(" ");
}

function DecisionError({ error }: { error: ParsedApiError | null }) {
  if (error === null) {
    return null;
  }
  const recovery =
    error.status === 409
      ? "Reload to refresh; nothing was written by this attempt."
      : error.status === 500
        ? "Stored bytes disagree with the database; no client retry can fix that — report it, do not force it."
        : "Nothing was written by this attempt.";
  return (
    <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs">
      <p className="font-semibold">
        {error.status === 409 ? "Changed under you" : error.status === 500 ? "Integrity failure" : "Request refused"} ({error.code})
      </p>
      <p className="mt-1">{error.message}</p>
      <p className="mt-1 text-muted-foreground">{recovery}</p>
    </div>
  );
}

function DeclineModal({
  open,
  onOpenChange,
  versionLabel,
  busy,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versionLabel: string;
  busy: boolean;
  error: ParsedApiError | null;
  onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      // Fresh note per opening: a stale decline reason must never
      // attach to a later decision.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNote("");
      setNoteError(null);
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader className="border-b border-border/60 pb-3">
          <DialogTitle>Decline {versionLabel}</DialogTitle>
          <DialogDescription>
            The decline note is required and persists on the review. Declining queues no work and
            changes no pointer — the next version starts explicitly when ready.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold">Decline note (required)</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={4}
              maxLength={4000}
              disabled={busy}
              placeholder="What is wrong with this version?"
              className="w-full rounded-md border border-border/70 bg-background p-2 text-xs"
            />
          </label>
          {noteError !== null && (
            <p role="alert" className="text-xs text-destructive">
              {noteError}
            </p>
          )}
          <DecisionError error={error} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => {
              if (note.trim() === "") {
                setNoteError("A decline note is required.");
                return;
              }
              setNoteError(null);
              onSubmit(note.trim());
            }}
          >
            {busy ? "Declining…" : "Decline version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RevisePrep {
  workspace: WorkspaceAny;
  preparation: PreparationStatus | null;
}

function useRevisePrep(jobId: string, open: boolean) {
  const [prep, setPrep] = useState<RevisePrep | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      // Modal closed: drop the fetched Step 2 snapshot so a later
      // opening refetches instead of trusting stale prep.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPrep(null);
      setState("idle");
      setError(null);
      return;
    }
    let cancelled = false;
    setState("loading");
    setError(null);
    (async () => {
      try {
        const [workspaceResponse, preparationResponse] = await Promise.all([
          fetch(`/api/jobs/${jobId}/tailoring/workspace`),
          fetch(`/api/jobs/${jobId}/tailoring/preparation`),
        ]);
        if (!workspaceResponse.ok) {
          throw new Error("Step 2 workspace failed to load.");
        }
        const workspaceBody = (await workspaceResponse.json()) as {
          workspace?: WorkspaceAny;
        };
        let preparation: PreparationStatus | null = null;
        if (preparationResponse.ok) {
          const preparationBody = (await preparationResponse.json()) as {
            preparation?: PreparationStatus;
          };
          preparation = preparationBody.preparation ?? null;
        }
        if (!cancelled) {
          setPrep({ workspace: workspaceBody.workspace ?? null, preparation });
          setState("idle");
        }
      } catch (err) {
        if (!cancelled) {
          setState("error");
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, open]);
  return { prep, state, error };
}

function workspaceDraftSummary(workspace: WorkspaceAny): string {
  if (workspace === null) {
    return "none";
  }
  const draft = (workspace as { draft?: unknown }).draft as
    | { planId?: unknown; operations?: unknown[]; summaryText?: unknown }
    | null
    | undefined;
  if (draft === null || draft === undefined || typeof draft !== "object") {
    return "empty draft";
  }
  const operations = Array.isArray((draft as { operations?: unknown }).operations)
    ? ((draft as { operations: unknown[] }).operations.length ?? 0)
    : 0;
  return `${operations} operation${operations === 1 ? "" : "s"}`;
}

function ReviseModal({
  open,
  onOpenChange,
  jobId,
  versionLabel,
  review,
  isActive,
  busy,
  error,
  onEditorContinue,
  onImmediateRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  versionLabel: string;
  review: WorkflowReviewV2;
  isActive: boolean;
  busy: boolean;
  error: ParsedApiError | null;
  onEditorContinue: (note: string, prep: RevisePrep) => void;
  onImmediateRun: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [rebindConfirmed, setRebindConfirmed] = useState(false);
  const isCorrection =
    review.format === "edited-plan" && review.validation?.policyVersion === "step2-claims/2";
  const { prep, state: prepState, error: prepError } = useRevisePrep(jobId, open && isCorrection);
  useEffect(() => {
    if (open) {
      // Fresh note and rebind confirmation per opening: neither may
      // leak from a previous request-changes round.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNote("");
      setNoteError(null);
      setRebindConfirmed(false);
    }
  }, [open]);

  const acceptedPlanId = prep?.preparation?.acceptedPlanId ?? null;
  const versionPlanId = review.validation?.planId ?? null;
  const drifted =
    isCorrection && acceptedPlanId !== null && versionPlanId !== null && acceptedPlanId !== versionPlanId;
  const noAcceptedPlan = isCorrection && prepState === "idle" && acceptedPlanId === null;
  const unsentEdits =
    prep?.workspace !== null &&
    prep?.workspace !== undefined &&
    (prep.workspace as { revision?: number; lastSubmittedRevision?: number | null }).revision !==
      undefined &&
    ((prep.workspace as { lastSubmittedRevision?: number | null }).lastSubmittedRevision === null ||
      ((prep.workspace as { revision: number }).revision ?? 0) >
        ((prep.workspace as { lastSubmittedRevision?: number | null }).lastSubmittedRevision ?? 0));

  const canContinue =
    !busy &&
    note.trim() !== "" &&
    (!isCorrection || prepState === "idle") &&
    !noAcceptedPlan &&
    (!drifted || rebindConfirmed);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader className="border-b border-border/60 pb-3">
          <DialogTitle>Request changes — {versionLabel}</DialogTitle>
          <DialogDescription>
            {isCorrection
              ? "Your note and this version's saved plan and operations carry into the Step 2 editor. Nothing is submitted until you press Generate there."
              : "This previous-format version revises through the immediate command: submitting records your note and queues a revision run now."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold">Revision note (required)</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              maxLength={4000}
              disabled={busy}
              placeholder="What should change in the next version?"
              className="w-full rounded-md border border-border/70 bg-background p-2 text-xs"
            />
          </label>
          {noteError !== null && (
            <p role="alert" className="text-xs text-destructive">
              {noteError}
            </p>
          )}
          {isCorrection && prepState === "loading" && (
            <p className="text-xs text-muted-foreground" role="status">
              Loading current Step 2 state…
            </p>
          )}
          {isCorrection && prepError !== null && (
            <p role="alert" className="text-xs text-destructive">
              {prepError}
            </p>
          )}
          {isCorrection && prepState === "idle" && noAcceptedPlan && (
            <p role="alert" className="text-xs text-destructive">
              No accepted plan exists for this job — run Step 2 preparation before revising.
            </p>
          )}
          {isCorrection && prepState === "idle" && !noAcceptedPlan && (
            <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 text-xs">
              {drifted ? (
                <div className="space-y-2">
                  <p className="font-semibold">Plan drift — explicit rebind required.</p>
                  <p className="text-muted-foreground">
                    This version&apos;s plan was superseded by a newer accepted plan. Continuing
                    rebinds to the current plan with a fresh draft — the version&apos;s{" "}
                    {review.operations.length} saved operation
                    {review.operations.length === 1 ? "" : "s"} cannot transfer across plans.
                  </p>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={rebindConfirmed}
                      onChange={(event) => setRebindConfirmed(event.target.checked)}
                      disabled={busy}
                      className="mt-0.5"
                    />
                    <span>Rebind to the current accepted plan with a fresh draft.</span>
                  </label>
                </div>
              ) : (
                <p className="text-muted-foreground">
                  Reopens Step 2 on the same accepted plan with {review.operations.length} saved
                  operation{review.operations.length === 1 ? "" : "s"} and provenance intact —
                  never a blank draft.
                  {unsentEdits
                    ? " Your current unsent Step 2 edits will be replaced (current draft: " +
                      `${workspaceDraftSummary(prep?.workspace ?? null)}).`
                    : ""}
                </p>
              )}
            </div>
          )}
          {!isCorrection && !isActive && (
            <p role="alert" className="text-xs text-destructive">
              Only the active draft revises through the immediate command; this older version can
              be approved or declined.
            </p>
          )}
          <DecisionError error={error} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canContinue || (!isCorrection && !isActive)}
            onClick={() => {
              if (note.trim() === "") {
                setNoteError("A revision note is required.");
                return;
              }
              setNoteError(null);
              if (isCorrection) {
                if (prep !== null) {
                  onEditorContinue(note.trim(), prep);
                }
              } else {
                onImmediateRun(note.trim());
              }
            }}
          >
            {busy ? "Working…" : isCorrection ? "Continue to editor" : "Request revision run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewVersionModal({
  open,
  onOpenChange,
  jobId,
  versionLabel,
  review,
  busy,
  error,
  onContinue,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  versionLabel: string;
  review: WorkflowReviewV2;
  busy: boolean;
  error: ParsedApiError | null;
  onContinue: (prep: RevisePrep) => void;
}) {
  const isCorrection =
    review.format === "edited-plan" && review.validation?.policyVersion === "step2-claims/2";
  const { prep, state: prepState, error: prepError } = useRevisePrep(jobId, open && isCorrection);
  const acceptedPlanId = prep?.preparation?.acceptedPlanId ?? null;
  const workspacePlanId =
    prep?.workspace !== null && prep?.workspace !== undefined
      ? ((prep.workspace as { draft?: { planId?: unknown } }).draft?.planId ?? null)
      : null;
  const staleWorkspace =
    isCorrection &&
    prepState === "idle" &&
    acceptedPlanId !== null &&
    workspacePlanId !== null &&
    workspacePlanId !== acceptedPlanId;
  const noAcceptedPlan = isCorrection && prepState === "idle" && acceptedPlanId === null;
  const canContinue =
    isCorrection && !busy && prepState === "idle" && !noAcceptedPlan && prep !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader className="border-b border-border/60 pb-3">
          <DialogTitle>Generate new version — {versionLabel}</DialogTitle>
          <DialogDescription>
            {isCorrection
              ? "A new version branches from this version into the Step 2 editor. Nothing is submitted until you press Generate there."
              : "This previous-format version has no Step 2 editor path."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2 text-xs">
          {!isCorrection && (
            <p className="rounded-md border border-border/60 bg-muted/20 p-2.5 text-muted-foreground">
              {versionLabel} uses the previous format. Generate its follow-up from the board, where
              the previous-format guidance still runs.{" "}
              <Link href="/" className="font-semibold underline">
                Open the board
              </Link>
            </p>
          )}
          {isCorrection && prepState === "loading" && (
            <p className="text-muted-foreground" role="status">
              Loading current Step 2 state…
            </p>
          )}
          {isCorrection && prepError !== null && (
            <p role="alert" className="text-destructive">
              {prepError}
            </p>
          )}
          {isCorrection && prepState === "idle" && noAcceptedPlan && (
            <p role="alert" className="text-destructive">
              No accepted plan exists for this job — run Step 2 preparation first.
            </p>
          )}
          {isCorrection && prepState === "idle" && !noAcceptedPlan && (
            <p className="rounded-md border border-border/60 bg-muted/20 p-2.5 text-muted-foreground">
              {staleWorkspace
                ? "Your saved Step 2 draft targets a superseded plan, so this version starts fresh on the current accepted plan (current draft: " +
                  `${workspaceDraftSummary(prep?.workspace ?? null)}).`
                : prep?.workspace === null || prep?.workspace === undefined
                  ? "Starts fresh on the current accepted plan."
                  : "Starts from your current Step 2 draft (" +
                    `${workspaceDraftSummary(prep.workspace)}).`}
            </p>
          )}
          <DecisionError error={error} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canContinue}
            onClick={() => {
              if (prep !== null) {
                onContinue(prep);
              }
            }}
          >
            {busy ? "Working…" : "Continue to editor"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function requestBinding(prep: RevisePrep): {
  extractionId: string | null;
  profileId: string | null;
  profileVersionId: string | null;
} | null {
  const draft = (
    prep.workspace as {
      draft?: {
        extractionId?: string | null;
        profileId?: string | null;
        profileVersionId?: string | null;
      } | null;
    } | null
  )?.draft;
  if (
    draft !== null &&
    draft !== undefined &&
    typeof draft === "object" &&
    draft.extractionId != null &&
    draft.profileId != null &&
    draft.profileVersionId != null
  ) {
    return {
      extractionId: draft.extractionId,
      profileId: draft.profileId,
      profileVersionId: draft.profileVersionId,
    };
  }
  const binding = prep.preparation?.binding ?? null;
  const extractionId = prep.preparation?.extractionId ?? null;
  if (
    binding === null ||
    extractionId === null ||
    binding.profileId === undefined ||
    binding.profileVersionId === undefined
  ) {
    return null;
  }
  return {
    extractionId,
    profileId: binding.profileId,
    profileVersionId: binding.profileVersionId,
  };
}

function ReviewGate({
  allowed,
  approveConsequence,
  olderNote,
  busy,
  onRevise,
  onNewVersion,
}: {
  allowed: WorkflowReviewV2["allowedActions"];
  approveConsequence: string | null;
  olderNote: string;
  busy: boolean;
  onRevise: () => void;
  onNewVersion: () => void;
}) {
  if (!allowed.approve && !allowed.decline && !allowed.revise && !allowed.newVersion) {
    return (
      <div className="rounded-lg border border-border/60 bg-card p-4">
        <h3 className="text-sm font-semibold">Review gate</h3>
        <p className="mt-2 text-xs text-muted-foreground" role="note">
          {allowed.reason ?? "No action applies to this version in its current state."}
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border/60 bg-card p-4">
      <h3 className="text-sm font-semibold">Review gate</h3>
      <div className="mt-2 space-y-2 text-xs">
        {approveConsequence !== null && allowed.approve && (
          <p className="text-muted-foreground">
            {approveConsequence}
            {olderNote}
          </p>
        )}
        {allowed.reason !== null && !(allowed.approve && allowed.decline) && (
          <p className="text-muted-foreground" role="note">
            {allowed.reason}
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            disabled={!allowed.revise || busy}
            title={allowed.revise ? undefined : (allowed.reason ?? "Revision is unavailable")}
            onClick={onRevise}
          >
            Request changes
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!allowed.newVersion || busy}
            title={allowed.newVersion ? undefined : "No new version applies to this state"}
            onClick={onNewVersion}
          >
            Generate new version
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function Step4Review({
  jobId,
  versions,
  initialVersionId,
  onNavigateStep,
}: {
  jobId: string;
  versions: VersionSummary[];
  initialVersionId: string | null;
  onNavigateStep: (step: StepNumber) => void;
}) {
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    initialVersionId ?? versions[0]?.id ?? null,
  );
  const { view, state: loadState, error: loadError, reload } = useReviewVersion(selectedVersionId);
  const [decision, setDecision] = useState<"approve" | "decline" | "revise" | "newVersion" | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<ParsedApiError | null>(null);
  const approveTriggerRef = useRef<HTMLButtonElement>(null);

  const review: WorkflowReviewV2 | null = view?.workflowReview ?? null;
  const activeVersion = useMemo(
    () => versions.find((v) => v.id === selectedVersionId) ?? versions[0] ?? null,
    [versions, selectedVersionId],
  );
  const latestVersionNumber = useMemo(
    () => versions.reduce((max, v) => Math.max(max, v.version), 0),
    [versions],
  );

  const selectVersion = useCallback(
    (id: string) => {
      setSelectedVersionId(id);
      setDecision(null);
      setDecisionError(null);
      const url = new URL(window.location.href);
      url.searchParams.set("step", "4");
      url.searchParams.set("version", id);
      window.history.pushState({}, "", url.toString());
    },
    [],
  );

  const reloadTailor = useCallback(
    (step: StepNumber, versionId: string | null) => {
      const url = new URL(window.location.href);
      url.searchParams.set("step", String(step));
      if (versionId !== null) {
        url.searchParams.set("version", versionId);
      } else {
        url.searchParams.delete("version");
      }
      window.location.assign(url.toString());
    },
    [],
  );

  async function postDecision(
    path: "approve" | "decline" | "revise",
    body: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; error: ParsedApiError }> {
    const response = await fetch(`/api/jobs/${jobId}/resume/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) {
      return { ok: true };
    }
    return { ok: false, error: await parseApiError(response) };
  }

  const observedRowVersion = view?.job.rowVersion ?? null;

  const submitApprove = useCallback(async () => {
    if (selectedVersionId === null || observedRowVersion === null || busy) {
      return;
    }
    setBusy(true);
    setDecisionError(null);
    try {
      const result = await postDecision("approve", {
        resumeVersionId: selectedVersionId,
        observedRowVersion,
      });
      if (result.ok) {
        reloadTailor(4, selectedVersionId);
        return;
      }
      setDecisionError(result.error);
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVersionId, observedRowVersion, busy, jobId]);

  const submitDecline = useCallback(
    async (note: string) => {
      if (selectedVersionId === null || observedRowVersion === null || busy) {
        return;
      }
      setBusy(true);
      setDecisionError(null);
      try {
        const result = await postDecision("decline", {
          resumeVersionId: selectedVersionId,
          observedRowVersion,
          note,
        });
        if (result.ok) {
          reloadTailor(4, selectedVersionId);
          return;
        }
        setDecisionError(result.error);
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedVersionId, observedRowVersion, busy, jobId],
  );

  const submitImmediateRevise = useCallback(
    async (note: string) => {
      if (selectedVersionId === null || observedRowVersion === null || busy) {
        return;
      }
      setBusy(true);
      setDecisionError(null);
      try {
        const result = await postDecision("revise", {
          resumeVersionId: selectedVersionId,
          observedRowVersion,
          note,
        });
        if (result.ok) {
          reloadTailor(3, selectedVersionId);
          return;
        }
        setDecisionError(result.error);
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedVersionId, observedRowVersion, busy, jobId],
  );

  async function putWorkspaceRevision(
    prep: RevisePrep,
    body: {
      requestKind: "REVISION" | "NEW_VERSION";
      parentVersionId: string;
      revisionNote: string | null;
      planId: string;
      planHash: string;
      draft: {
        summaryText: string;
        summaryOrigin: "master" | "angle-1" | "angle-2";
        operations: unknown[];
      } | null;
    },
  ): Promise<ParsedApiError | null> {
    const fullDraft =
      body.draft === null
        ? null
        : {
            schemaVersion: STEP2_CORRECTION_VERSIONS.draft,
            planId: body.planId,
            planHash: body.planHash,
            summaryText: body.draft.summaryText,
            summaryOrigin: body.draft.summaryOrigin,
            operations: body.draft.operations,
          };
    const binding = requestBinding(prep);
    if (binding === null) {
      return {
        status: 0,
        code: "NO_BINDING",
        message: "No profile binding is available — open Step 2 and pick a profile first.",
      };
    }
    const revision =
      prep.workspace === null
        ? 0
        : ((prep.workspace as { revision?: number }).revision ?? 0);
    const response = await fetch(`/api/jobs/${jobId}/tailoring/workspace`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": buildWorkspaceETag(jobId, revision),
      },
      body: JSON.stringify({
        schemaVersion: "tailoring-workspace/v3",
        extractionId: binding.extractionId,
        profileId: binding.profileId,
        profileVersionId: binding.profileVersionId,
        requestKind: body.requestKind,
        parentVersionId: body.parentVersionId,
        revisionNote: body.revisionNote,
        planId: body.planId,
        planHash: body.planHash,
        recommendationHash: null,
        draft: fullDraft,
      }),
    });
    if (response.ok) {
      return null;
    }
    return parseApiError(response);
  }

  const continueEditorRevise = useCallback(
    async (note: string, prep: RevisePrep) => {
      if (review === null || selectedVersionId === null || busy) {
        return;
      }
      setBusy(true);
      setDecisionError(null);
      try {
        const acceptedPlanId = prep.preparation?.acceptedPlanId ?? null;
        const acceptedPlanHash = prep.preparation?.acceptedPlanHash ?? null;
        const versionPlanId = review.validation?.planId ?? null;
        const versionPlanHash = review.validation?.planHash ?? null;
        const drifted =
          acceptedPlanId !== null && versionPlanId !== null && acceptedPlanId !== versionPlanId;
        if (acceptedPlanId === null || acceptedPlanHash === null) {
          setDecisionError({
            status: 0,
            code: "NO_ACCEPTED_PLAN",
            message: "No accepted plan exists — run Step 2 preparation first.",
          });
          return;
        }
        const error = drifted
          ? await putWorkspaceRevision(prep, {
              requestKind: "REVISION",
              parentVersionId: selectedVersionId,
              revisionNote: note,
              planId: acceptedPlanId,
              planHash: acceptedPlanHash,
              draft: null,
            })
          : versionPlanId === null ||
              versionPlanHash === null ||
              review.summaryText === null ||
              review.summaryOrigin === null ||
              review.summaryOrigin === "edited" ||
              review.summaryOrigin === "focus"
            ? {
                status: 0,
                code: "PLAN_UNAVAILABLE",
                message:
                  "This version's saved plan is unavailable — generate a new version instead.",
              } satisfies ParsedApiError
            : await putWorkspaceRevision(prep, {
                requestKind: "REVISION",
                parentVersionId: selectedVersionId,
                revisionNote: note,
                planId: versionPlanId,
                planHash: versionPlanHash,
                draft: {
                  summaryText: review.summaryText,
                  summaryOrigin: review.summaryOrigin,
                  operations: review.operations.map((op) => op.raw),
                },
              });
        if (error !== null) {
          setDecisionError(error);
          return;
        }
        onNavigateStep(2);
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [review, selectedVersionId, busy, jobId, onNavigateStep],
  );

  const continueNewVersion = useCallback(
    async (prep: RevisePrep) => {
      if (review === null || selectedVersionId === null || busy) {
        return;
      }
      setBusy(true);
      setDecisionError(null);
      try {
        const acceptedPlanId = prep.preparation?.acceptedPlanId ?? null;
        const acceptedPlanHash = prep.preparation?.acceptedPlanHash ?? null;
        if (acceptedPlanId === null || acceptedPlanHash === null) {
          setDecisionError({
            status: 0,
            code: "NO_ACCEPTED_PLAN",
            message: "No accepted plan exists — run Step 2 preparation first.",
          });
          return;
        }
        const current = prep.workspace as {
          draft?: {
            schemaVersion?: string;
            planId?: string;
            draft?: {
              summaryText?: string;
              summaryOrigin?: "master" | "angle-1" | "angle-2";
              operations?: unknown[];
            } | null;
          } | null;
        } | null;
        const keepDraft =
          current?.draft !== null &&
          current?.draft !== undefined &&
          current.draft.schemaVersion === "tailoring-workspace/v3" &&
          current.draft.planId === acceptedPlanId &&
          current.draft.draft !== null &&
          current.draft.draft !== undefined;
        const error = await putWorkspaceRevision(prep, {
          requestKind: "NEW_VERSION",
          parentVersionId: selectedVersionId,
          revisionNote: null,
          planId: acceptedPlanId,
          planHash: acceptedPlanHash,
          draft: keepDraft
            ? (current?.draft?.draft as {
                summaryText: string;
                summaryOrigin: "master" | "angle-1" | "angle-2";
                operations: unknown[];
              })
            : null,
        });
        if (error !== null) {
          setDecisionError(error);
          return;
        }
        onNavigateStep(2);
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [review, selectedVersionId, busy, jobId, onNavigateStep],
  );

  const allowed = review?.allowedActions ?? null;
  const versionLabel = activeVersion === null ? "this version" : `v${activeVersion.version}`;
  const approveConsequence =
    view === null || review === null
      ? null
      : view.job.status === "NEW"
        ? `Approval moves this job NEW → Tailored and selects ${versionLabel}.`
        : `Approval binds ${versionLabel} as the selected resume. Status, application version, and confirmation stay unchanged.`;
  const olderNote =
    review !== null && !review.markers.latestPublished
      ? ` Tailoring keeps following the latest draft (v${latestVersionNumber}).`
      : "";
  const pdfArtifact = view?.artifacts.find((artifact) => artifact.kind === "PDF") ?? null;
  const docxArtifact = view?.artifacts.find((artifact) => artifact.kind === "DOCX") ?? null;

  return (
    <section aria-label="Step 4 of 4: Review and Approve" className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => onNavigateStep(3)}>
            <ArrowLeft className="mr-1 h-3 w-3" /> Back to generation
          </Button>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={activeVersion === null || allowed === null || !allowed.decline || busy}
            title={allowed === null ? undefined : (allowed.decline ? undefined : (allowed.reason ?? "Declining is unavailable"))}
            onClick={() => {
              setDecisionError(null);
              setDecision("decline");
            }}
          >
            Decline version
          </Button>
          <Button
            size="sm"
            ref={approveTriggerRef}
            disabled={activeVersion === null || allowed === null || !allowed.approve || busy}
            title={allowed === null ? undefined : (allowed.approve ? undefined : (allowed.reason ?? "Approval is unavailable"))}
            onClick={() => void submitApprove()}
          >
            {busy && decision === null ? "Approving…" : "Approve version"}
          </Button>
        </div>
      </div>

      {versions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 p-6 text-center">
          <h3 className="text-sm font-semibold">No Tailored Versions Available</h3>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
            Generate a tailored resume in Step 2 first. Review, approval, and downloads unlock here
            once a version exists.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Resume versions">
            {versions.map((version) => (
              <Button
                key={version.id}
                size="sm"
                variant={version.id === selectedVersionId ? "default" : "outline"}
                onClick={() => selectVersion(version.id)}
              >
                v{version.version} · {formatState(version.reviewState)}
                {version.selectedApproved ? " · Selected" : ""}
                {version.latestPublished ? "" : " · Older"}
              </Button>
            ))}
          </div>

          {loadState === "loading" && (
            <p role="status" className="text-xs text-muted-foreground">
              Loading exact-version review…
            </p>
          )}
          {loadState === "error" && (
            <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs">
              <p className="font-semibold">Review failed to load</p>
              <p className="mt-1">{loadError}</p>
              {reload !== null && (
                <Button size="sm" variant="outline" className="mt-2" onClick={() => void reload()}>
                  Retry
                </Button>
              )}
            </div>
          )}
          {decisionError !== null && decision === null && <DecisionError error={decisionError} />}

          {view !== null && review !== null && loadState === "idle" && (
            <div className="space-y-4">
              <div className="rounded-lg border border-border/60 bg-card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold">Resume Version {review.version.version}</h3>
                  <Badge variant="outline">{formatState(review.version.reviewState)}</Badge>
                  {review.markers.latestPublished && <Badge variant="secondary">Latest</Badge>}
                  {review.markers.selectedApproved && <Badge variant="secondary">Selected</Badge>}
                  {!review.markers.latestPublished && <Badge variant="outline">Older</Badge>}
                  {review.markers.isApplicationVersion && (
                    <Badge variant="secondary">
                      Application version{review.markers.appliedAt ? ` · ${review.markers.appliedAt.slice(0, 10)}` : ""}
                    </Badge>
                  )}
                  {review.format === "legacy" && <Badge variant="outline">Previous format</Badge>}
                </div>
                <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs md:grid-cols-2">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Request</dt>
                    <dd className="font-mono">
                      {review.request === null
                        ? "none (previous format)"
                        : `${review.request.kind}${review.parent === null ? "" : ` · parent v${review.parent.version}`}`}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Profile</dt>
                    <dd className="font-mono">
                      {review.profile === null
                        ? "unavailable"
                        : `v${review.profile.profileVersionNumber ?? "?"} (frozen)`}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Summary origin</dt>
                    <dd className="font-mono">{review.summaryOrigin ?? "unavailable"}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Validation</dt>
                    <dd className="font-mono">
                      {review.validation === null
                        ? "unavailable"
                        : `${review.validation.policyVersion} · plan ${review.validation.planId?.slice(0, 8) ?? "?"}`}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Master baseline</dt>
                    <dd className="font-mono">
                      {review.master === null ? "baseline unavailable" : `${review.master.hash.slice(0, 12)}…`}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Content</dt>
                    <dd className="font-mono">{review.version.contentHash.slice(0, 12)}…</dd>
                  </div>
                </dl>
                {review.master === null && (
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground" role="note">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    This version predates frozen baselines: assessment and master comparison are
                    unavailable, and the current master is never substituted.
                  </p>
                )}
              </div>

              <div className="rounded-lg border border-border/60 bg-card p-4">
                <h3 className="text-sm font-semibold">Measures</h3>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Four independent measures over frozen inputs — no composite score.
                </p>
                {review.assessment === null ? (
                  <p className="mt-2 text-xs text-muted-foreground" role="note">
                    Not assessed — this version predates assessment. No score is shown or implied.
                  </p>
                ) : (
                  <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                    {review.assessment.measures.map((measure) => (
                      <MeasureCard key={measure.key} measure={measure} />
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-border/60 bg-card p-4">
                <h3 className="text-sm font-semibold">Insights</h3>
                <ul className="mt-2 space-y-2">
                  {review.insights.map((insight) => (
                    <li key={insight.id} className="flex items-start gap-2 text-xs">
                      <Badge variant="outline" className="mt-0.5 shrink-0">
                        {INSIGHT_KIND_LABEL[insight.kind]}
                      </Badge>
                      <span>{insight.text}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <ReviewGate
                allowed={review.allowedActions}
                approveConsequence={approveConsequence}
                olderNote={olderNote}
                busy={busy}
                onRevise={() => {
                  setDecisionError(null);
                  setDecision("revise");
                }}
                onNewVersion={() => {
                  setDecisionError(null);
                  setDecision("newVersion");
                }}
              />

              <div className="rounded-lg border border-border/60 bg-card p-4">
                <h3 className="text-sm font-semibold">Master versus tailored</h3>
                {review.master === null || review.tailoredTextStatus !== "ok" ? (
                  <p className="mt-2 text-xs text-muted-foreground" role="note">
                    {review.master === null
                      ? "Baseline unavailable — no frozen master exists for this version, so no diff is shown."
                      : review.tailoredTextStatus === "mismatch"
                        ? "The stored tailored bytes disagree with the database — the diff is withheld rather than show the wrong document."
                        : review.tailoredTextStatus === "missing"
                          ? "The stored tailored bytes are missing — the diff is unavailable."
                          : "Tailored bytes are unchecked in this context — the diff is unavailable."}
                  </p>
                ) : (
                  <div className="mt-3">
                    <Step4Diff
                      masterText={review.master.text}
                      tailoredText={review.tailoredText}
                      segments={review.segments}
                      excludedTexts={review.excludedTexts}
                    />
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-border/60 bg-card p-4">
                <h3 className="text-sm font-semibold">Full tailored resume</h3>
                {review.tailoredTextStatus !== "ok" ? (
                  <p className="mt-2 text-xs text-muted-foreground" role="note">
                    The exact canonical text is unavailable ({review.tailoredTextStatus}).
                  </p>
                ) : (
                  <pre className="mt-2 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/20 p-3 text-xs leading-relaxed">
                    {review.tailoredText}
                  </pre>
                )}
                {review.master !== null && (
                  <details className="mt-3 text-xs">
                    <summary className="cursor-pointer font-semibold">
                      Frozen master text ({review.master.hash.slice(0, 12)}…)
                    </summary>
                    <pre className="mt-2 max-h-[320px] overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/20 p-3 leading-relaxed">
                      {review.master.text}
                    </pre>
                  </details>
                )}
              </div>

              {review.segments.length > 0 && (
                <div className="rounded-lg border border-border/60 bg-card p-4">
                  <h3 className="text-sm font-semibold">Included segments</h3>
                  <ol className="mt-2 space-y-1.5">
                    {review.segments.map((segment) => (
                      <li key={segment.segmentId} className="flex items-start gap-2 text-xs">
                        <Badge variant="outline" className="mt-0.5 shrink-0">
                          {PROVENANCE_BADGE[segment.provenance] ?? segment.provenance}
                        </Badge>
                        <span className="min-w-0">
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {segment.segmentId} · {segment.kind}
                            {segment.sourceOperationId ? ` · op ${segment.sourceOperationId.slice(0, 8)}` : ""}
                          </span>
                          <span className="block truncate">{segment.text}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {review.operations.length > 0 && (
                <div className="rounded-lg border border-border/60 bg-card p-4">
                  <h3 className="text-sm font-semibold">Ordered operations</h3>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs">
                    {review.operations.map((operation) => (
                      <li key={operation.operationId}>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          [{operation.op}]
                        </span>{" "}
                        {operation.detail}
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              <div className="rounded-lg border border-border/60 bg-card p-4">
                <h3 className="text-sm font-semibold">Previews and files</h3>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  {pdfArtifact !== null ? (
                    <a
                      href={`/api/resumes/artifacts/${pdfArtifact.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 font-medium text-primary-foreground hover:bg-primary/90"
                    >
                      <FileText className="h-3.5 w-3.5" /> Open exact PDF
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (
                    <span className="text-muted-foreground">No PDF artifact recorded.</span>
                  )}
                  {docxArtifact !== null && (
                    <span className="inline-flex items-center gap-2">
                      <a
                        href={`/api/resumes/artifacts/${docxArtifact.id}/content`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2.5 py-1.5 font-medium hover:bg-muted/40"
                      >
                        DOCX content preview <ExternalLink className="h-3 w-3" />
                      </a>
                      <span className="text-[11px] text-muted-foreground">
                        Content preview — not pixel-identical.
                      </span>
                    </span>
                  )}
                </div>
                {review.version.reviewState === "APPROVED" && (
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground" role="note">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                    Approved by a human. Applying stays manual: open the retained application link,
                    apply yourself, then record the outcome on the board.
                  </p>
                )}
              </div>
            </div>
          )}

          {view !== null && review === null && loadState === "idle" && (
            <p role="note" className="rounded-lg border border-border/60 bg-card p-4 text-xs text-muted-foreground">
              The exact-version extension is unavailable for this version. The decision buttons above
              stay disabled; approve or decline from the board instead.
            </p>
          )}
        </>
      )}

      {review !== null && activeVersion !== null && (
        <>
          <DeclineModal
            open={decision === "decline"}
            onOpenChange={(next) => {
              if (!busy) {
                setDecision(next ? "decline" : null);
                if (!next) {
                  setDecisionError(null);
                }
              }
            }}
            versionLabel={versionLabel}
            busy={busy}
            error={decisionError}
            onSubmit={(note) => void submitDecline(note)}
          />
          <ReviseModal
            open={decision === "revise"}
            onOpenChange={(next) => {
              if (!busy) {
                setDecision(next ? "revise" : null);
                if (!next) {
                  setDecisionError(null);
                }
              }
            }}
            jobId={jobId}
            versionLabel={versionLabel}
            review={review}
            isActive={review.markers.latestPublished}
            busy={busy}
            error={decisionError}
            onEditorContinue={(note, prep) => void continueEditorRevise(note, prep)}
            onImmediateRun={(note) => void submitImmediateRevise(note)}
          />
          <NewVersionModal
            open={decision === "newVersion"}
            onOpenChange={(next) => {
              if (!busy) {
                setDecision(next ? "newVersion" : null);
                if (!next) {
                  setDecisionError(null);
                }
              }
            }}
            jobId={jobId}
            versionLabel={versionLabel}
            review={review}
            busy={busy}
            error={decisionError}
            onContinue={(prep) => void continueNewVersion(prep)}
          />
        </>
      )}
    </section>
  );
}

export type { JobDetailView };
