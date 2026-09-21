"use client";

import { useEffect, useState } from "react";
import { ArrowRight, ExternalLink, FileText, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { WorkspaceViewV2 } from "@/src/domain/step2";
import type { WorkspaceViewV3 } from "@/src/domain/step2Correction";
import {
  resolveTailorEntry,
  tailorReviewHref,
  tailorStepHref,
  workspaceHasDraft,
  type TailorEntry,
} from "@/src/domain/tailorEntry";
import type { WorkspaceView } from "@/src/domain/tailoringWorkspace";
import { apiGet, errorMessage } from "../api";

type WorkspaceViewAny = WorkspaceView | WorkspaceViewV2 | WorkspaceViewV3;

interface EntryVersion {
  id: string;
  version: number;
  reviewState: string;
  profileDisplayName: string | null;
  profileName: string | null;
}

interface TailorEntryPanelProps {
  jobId: string;
  tailoringState: string;
  tailoringReasonCode: string | null;
  tailorLive: boolean;
  versions: EntryVersion[];
}

interface PreparationSnapshot {
  state: "ABSENT" | "PENDING" | "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  acceptedPlanId: string | null;
  failureCode: string | null;
}

function readPreparationSnapshot(value: unknown): PreparationSnapshot | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const prep = (record["preparation"] ?? record) as Record<string, unknown>;
  const state = prep["state"];
  if (
    state !== "ABSENT" &&
    state !== "PENDING" &&
    state !== "QUEUED" &&
    state !== "RUNNING" &&
    state !== "SUCCEEDED" &&
    state !== "FAILED"
  ) {
    return null;
  }
  const acceptedPlanId = prep["acceptedPlanId"];
  const failure = prep["failure"] as { code?: unknown } | null | undefined;
  return {
    state,
    acceptedPlanId: typeof acceptedPlanId === "string" ? acceptedPlanId : null,
    failureCode:
      failure !== null && failure !== undefined && typeof failure.code === "string"
        ? failure.code
        : null,
  };
}

function readWorkspaceSnapshot(value: unknown): WorkspaceViewAny | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const workspace = ("workspace" in record ? record["workspace"] : record) as WorkspaceViewAny | null;
  if (workspace === null || typeof workspace !== "object") {
    return null;
  }
  if (typeof workspace.revision !== "number") {
    return null;
  }
  return workspace;
}

function prettyState(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function entryLinkText(entry: TailorEntry): string {
  switch (entry.state) {
    case "generating":
      return entry.step === 3 ? "Watch progress in Step 3" : "Watch preparation in Step 2";
    case "failed":
      return "Open failure details in Step 3";
    case "blocked":
      return "Resolve the block in Step 2";
    case "editing":
      return "Continue editing in Step 2";
    case "prepared":
      return "Review the prepared plan in Step 2";
    default:
      return "Start tailoring in Step 1";
  }
}

/**
 * WO-1.3-H drawer entry panel: replaces the duplicate drawer
 * generation/review controls with state + deep links into the
 * tailor route. Shows the identical Step 2 vocabulary as the route
 * (prepared, editing, blocked-with-reason, generating, failed), one
 * primary step link, and exact per-version review links. Read-only:
 * it issues no mutations.
 */
export default function TailorEntryPanel({
  jobId,
  tailoringState,
  tailoringReasonCode,
  tailorLive,
  versions,
}: TailorEntryPanelProps) {
  const [preparation, setPreparation] = useState<PreparationSnapshot | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceViewAny | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const [prepJson, workspaceJson] = await Promise.all([
          apiGet<unknown>(`/api/jobs/${jobId}/tailoring/preparation`),
          apiGet<unknown>(`/api/jobs/${jobId}/tailoring/workspace`),
        ]);
        if (cancelled) {
          return;
        }
        setPreparation(readPreparationSnapshot(prepJson));
        setWorkspace(readWorkspaceSnapshot(workspaceJson));
        setLoadError(null);
      } catch (fetchError: unknown) {
        if (!cancelled) {
          setLoadError(errorMessage(fetchError));
        }
      } finally {
        if (!cancelled) {
          setLoaded(true);
        }
      }
    }
    void load();
    if (!tailorLive) {
      return () => {
        cancelled = true;
      };
    }
    const timer = setInterval(() => {
      void load();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobId, tailorLive]);

  const entry = resolveTailorEntry({
    tailorLive,
    tailoringState,
    tailoringReasonCode,
    preparationState: preparation?.state ?? "ABSENT",
    preparationFailure: preparation?.failureCode ?? null,
    acceptedPlanId: preparation?.acceptedPlanId ?? null,
    workspace:
      workspace === null
        ? null
        : {
            revision: workspace.revision,
            lastSubmittedRevision: workspace.lastSubmittedRevision,
            hasDraft: workspaceHasDraft(workspace),
          },
  });

  return (
    <div className="space-y-4">
      <section
        aria-labelledby="drawer-tailor-entry"
        className="rounded-lg border border-border/80 bg-card p-4 space-y-3"
      >
        <h3 id="drawer-tailor-entry" className="font-semibold text-sm flex items-center gap-2">
          <Sparkles className="size-4 text-primary" aria-hidden="true" />
          <span>Tailoring status</span>
        </h3>
        {!loaded ? (
          <p className="text-xs text-muted-foreground">Loading tailoring status…</p>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="secondary" className="text-xs font-medium">
                {entry.label}
              </Badge>
              {entry.reason !== null && (
                <span className="font-mono tabular-nums text-xs text-muted-foreground">
                  {entry.reason}
                </span>
              )}
            </p>
            {loadError !== null && (
              <p role="note" className="text-xs text-muted-foreground">
                Step 2 status unavailable ({loadError}) — the tailor flow below still opens.
              </p>
            )}
            <a
              href={tailorStepHref(jobId, entry.step)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
            >
              {entryLinkText(entry)}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </a>
            <p className="text-[11px] text-muted-foreground">
              Generation, editing, and review happen in the tailor flow — this drawer stays
              read-only for resumes.
            </p>
          </>
        )}
      </section>

      <section
        aria-labelledby="drawer-tailor-versions"
        className="rounded-lg border border-border/80 bg-card p-4 space-y-3"
      >
        <h3 id="drawer-tailor-versions" className="font-semibold text-sm flex items-center gap-2">
          <FileText className="size-4 text-primary" aria-hidden="true" />
          <span>Resume versions ({versions.length})</span>
        </h3>
        {versions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No tailored resumes yet.{" "}
            <a href={tailorStepHref(jobId, 1)} className="text-primary underline underline-offset-2">
              Start tailoring
            </a>
            .
          </p>
        ) : (
          <ul className="space-y-2">
            {versions.map((version) => (
              <li
                key={version.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/80 bg-card p-3"
              >
                <span className="text-sm font-semibold">Version {version.version}</span>
                <Badge variant="outline" className="text-[11px] py-0.5 font-medium">
                  {prettyState(version.reviewState)}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  Profile &ldquo;{version.profileDisplayName ?? version.profileName ?? "Unknown profile"}&rdquo;
                </span>
                <a
                  href={tailorReviewHref(jobId, version.id)}
                  aria-label={`Review version ${version.version} in the tailor flow`}
                  className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-primary underline-offset-2 hover:underline"
                >
                  Review
                  <ExternalLink className="size-3" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
