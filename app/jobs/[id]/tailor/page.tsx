import { notFound } from "next/navigation";
import { openRequestDatabase } from "@/app/api/_lib/request";
import TailoringWorkflowShell from "@/components/tailoring/TailoringWorkflowShell";
import { resolveAuthoritativeStep } from "@/src/domain/tailoringResolver";
import { getJobDetail } from "@/src/server/board";
import {
  getWorkspaceView,
  listVersionSummaries,
  type VersionSummary,
} from "@/src/server/tailoringWorkspace";

export const dynamic = "force-dynamic";

import type { DatabaseHandle } from "@/src/db/client";

interface TailorPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function checkTailoringExecutionStatus(handle: DatabaseHandle, jobId: string) {
  const liveRequest = handle.sqlite
    .prepare(
      `SELECT id, status FROM generation_requests
       WHERE job_id = ? AND status IN ('QUEUED', 'RUNNING')
       LIMIT 1`
    )
    .get(jobId) as { id: string; status: string } | undefined;

  const liveWorkItem = !liveRequest
    ? (handle.sqlite
        .prepare(
          `SELECT id, state FROM work_items
           WHERE job_id = ? AND kind = 'TAILOR' AND state IN ('QUEUED', 'RUNNING')
           LIMIT 1`
        )
        .get(jobId) as { id: string; state: string } | undefined)
    : undefined;

  const hasLiveRequest = liveRequest !== undefined || liveWorkItem !== undefined;
  const liveRequestId = liveRequest?.id ?? null;

  const latestRequest = handle.sqlite
    .prepare(
      `SELECT id, status FROM generation_requests
       WHERE job_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(jobId) as { id: string; status: string } | undefined;

  const lastRequestFailed = latestRequest?.status === "FAILED";

  return { hasLiveRequest, liveRequestId, lastRequestFailed };
}

export default async function TailorPage({ params, searchParams }: TailorPageProps) {
  const { id } = await params;

  // Validate UUID (C2)
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    return (
      <main className="mx-auto w-full max-w-lg px-4 py-16 text-center">
        <h1 className="text-xl font-bold text-destructive">400 — Invalid Job Identifier</h1>
        <p className="mt-2 text-xs text-muted-foreground">
          The requested job identifier is malformed.
        </p>
      </main>
    );
  }

  const query = await searchParams;
  const rawStep = query["step"];
  const rawVersion = query["version"] ?? query["versionId"];
  const stepParam = Array.isArray(rawStep) ? rawStep[0] : rawStep;
  const versionParam = Array.isArray(rawVersion) ? rawVersion[0] : rawVersion;

  const requestedStep =
    stepParam !== undefined && /^[1-4]$/.test(stepParam) ? (Number(stepParam) as 1 | 2 | 3 | 4) : null;
  const requestedVersionId =
    versionParam !== undefined && versionParam.trim() !== "" ? versionParam.trim() : null;

  const dbResult = openRequestDatabase();
  if (!dbResult.ok) {
    return (
      <main className="mx-auto w-full max-w-lg px-4 py-16 text-center">
        <h1 className="text-xl font-bold text-destructive">503 — Database Unavailable</h1>
        <p className="mt-2 text-xs text-muted-foreground">
          The local job database cannot be accessed.
        </p>
      </main>
    );
  }

  let jobDetail;
  let workspace = null;
  let versions: VersionSummary[] = [];
  let execStatus;

  try {
    const handle = dbResult.handle;

    // 1. Fetch Job Detail
    jobDetail = getJobDetail(handle, id);
    if (!jobDetail) {
      notFound();
    }

    // 2. Fetch Workspace View (without inserting, Q9 unchanged)
    const wsResult = getWorkspaceView(handle, id);
    if (wsResult.ok) {
      workspace = wsResult.value.workspace;
    }

    // 3. Fetch Versions
    const versionsResult = listVersionSummaries(handle, id, { limit: 50 });
    if (versionsResult.ok) {
      versions = versionsResult.versions;
    }

    // 4. Execution status (live runs, failures)
    execStatus = checkTailoringExecutionStatus(handle, id);
  } finally {
    dbResult.release();
  }

  // Foreign version check (C5)
  if (requestedVersionId !== null) {
    const isOwned = versions.some((v) => v.id === requestedVersionId);
    if (!isOwned) {
      notFound();
    }
  }

  // 5. Authoritative step resolution (§5, C5, C6)
  const resolved = resolveAuthoritativeStep({
    requestedStep,
    requestedVersionId,
    hasLiveRequest: execStatus.hasLiveRequest,
    liveRequestId: execStatus.liveRequestId,
    workspace: workspace
      ? {
          revision: workspace.revision,
          lastSubmittedRevision: workspace.lastSubmittedRevision,
        }
      : null,
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      reviewState: v.reviewState,
      selectedApproved: v.selectedApproved,
      latestPublished: v.latestPublished,
    })),
    lastRequestFailed: execStatus.lastRequestFailed,
  });

  return (
    <TailoringWorkflowShell
      jobDetail={jobDetail}
      workspace={workspace}
      versions={versions}
      initialStep={resolved.step}
      initialVersionId={resolved.selectedVersionId}
      hasLiveRequest={execStatus.hasLiveRequest}
      liveRequestId={execStatus.liveRequestId}
      isInspectMode={resolved.isInspectMode}
      canGenerate={resolved.canGenerate}
      canApprove={resolved.canApprove}
      maxStepReached={resolved.maxStepReached}
    />
  );
}
