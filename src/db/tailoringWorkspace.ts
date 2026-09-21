import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import type { DatabaseHandle } from "./client";
import {
  generationProgressEvents,
  generationRequests,
  resumeAssessments,
  resumeVersions,
  tailoringRequestInputs,
  tailoringWorkspaces,
  workAttempts,
  workItems,
  type GenerationProgressEvent,
  type ResumeAssessment,
  type TailoringRequestInputs,
  type TailoringWorkspace,
} from "./schema";
import { withTransaction } from "./transactions";

/**
 * v1.3 tailoring-workspace repositories (WO-1.3-B). Thin SQL over the
 * four 0008 tables plus the bounded progress read F consumes.
 *
 * Rules: every method runs in one short synchronous transaction
 * (nest-safe, so services compose them inside W/G/R/A/D); methods
 * accept trusted service clocks (`now`) and lease tuples as explicit
 * parameters, never ambient time; JSON columns are stored and
 * returned as text — services parse them through the strict Zod
 * schemas before treating any field as typed. Constraint and
 * trigger violations propagate as `SqliteError` carrying the exact
 * SQL name (`WORKSPACE_REVISION_INVALID`, `INPUT_IMMUTABLE`,
 * `INPUT_PROFILE_MISMATCH`, `LEASE_LOST`, `PROGRESS_*`,
 * `ASSESSMENT_*`); services map those to HTTP codes.
 */

export interface SaveWorkspaceInput {
  jobId: string;
  /** Revision from the caller's If-Match ETag; 0 creates the row. */
  observedRevision: number;
  extractionId: string | null;
  profileId: string | null;
  profileVersionId: string | null;
  requestKind: "INITIAL" | "NEW_VERSION" | "REVISION";
  parentVersionId: string | null;
  revisionNote: string | null;
  /** Canonical focus JSON bytes (service-validated). */
  focusJson: string;
  /** Canonical recommendations bytes, or null exactly when the hash is null. */
  recommendationsJson: string | null;
  recommendationHash: string | null;
  /** Trusted service clock (`Date.toISOString()`), never client input. */
  now: string;
}

export type SaveWorkspaceResult =
  | { ok: true; revision: number; created: boolean }
  | { ok: false; error: "conflict"; currentRevision: number };

/** One PK lookup; the service parses the JSON columns strictly. */
export function readWorkspace(handle: DatabaseHandle, jobId: string): TailoringWorkspace | null {
  const row = handle.db
    .select()
    .from(tailoringWorkspaces)
    .where(eq(tailoringWorkspaces.jobId, jobId))
    .get();
  return row ?? null;
}

/**
 * Compare-and-swap workspace save. Observed 0 inserts revision 1;
 * otherwise the update commits only when the stored revision still
 * equals the observed one. `last_request_id` /
 * `last_submitted_revision` are preserved untouched — only G
 * (`markWorkspaceSubmitted`) writes them, and the revision never
 * moves without this CAS (trigger `v13_workspace_cas`).
 */
export function saveWorkspaceCAS(
  handle: DatabaseHandle,
  input: SaveWorkspaceInput,
): SaveWorkspaceResult {
  return withTransaction(handle.sqlite, () => {
    const current = handle.db
      .select({ revision: tailoringWorkspaces.revision })
      .from(tailoringWorkspaces)
      .where(eq(tailoringWorkspaces.jobId, input.jobId))
      .get();
    if (current === undefined) {
      if (input.observedRevision !== 0) {
        return { ok: false, error: "conflict", currentRevision: 0 } as const;
      }
      handle.db
        .insert(tailoringWorkspaces)
        .values({
          jobId: input.jobId,
          revision: 1,
          extractionId: input.extractionId,
          profileId: input.profileId,
          profileVersionId: input.profileVersionId,
          requestKind: input.requestKind,
          parentVersionId: input.parentVersionId,
          revisionNote: input.revisionNote,
          focusJson: input.focusJson,
          recommendationsJson: input.recommendationsJson,
          recommendationHash: input.recommendationHash,
          lastRequestId: null,
          lastSubmittedRevision: null,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .run();
      return { ok: true, revision: 1, created: true } as const;
    }
    if (current.revision !== input.observedRevision) {
      return { ok: false, error: "conflict", currentRevision: current.revision } as const;
    }
    const changed = handle.db
      .update(tailoringWorkspaces)
      .set({
        revision: current.revision + 1,
        extractionId: input.extractionId,
        profileId: input.profileId,
        profileVersionId: input.profileVersionId,
        requestKind: input.requestKind,
        parentVersionId: input.parentVersionId,
        revisionNote: input.revisionNote,
        focusJson: input.focusJson,
        recommendationsJson: input.recommendationsJson,
        recommendationHash: input.recommendationHash,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(tailoringWorkspaces.jobId, input.jobId),
          eq(tailoringWorkspaces.revision, input.observedRevision),
        ),
      )
      .run().changes;
    if (changed !== 1) {
      const raced = readWorkspace(handle, input.jobId);
      return { ok: false, error: "conflict", currentRevision: raced?.revision ?? 0 } as const;
    }
    return { ok: true, revision: current.revision + 1, created: false } as const;
  });
}

export interface MarkWorkspaceSubmittedInput {
  jobId: string;
  observedRevision: number;
  requestId: string;
  now: string;
}

export type MarkWorkspaceSubmittedResult =
  | { ok: true; revision: number }
  | { ok: false; error: "conflict"; currentRevision: number };

/**
 * G's submission stamp (WO-1.3-E primitive): CAS the workspace
 * revision + 1 and bind `last_request_id` / `last_submitted_revision`
 * to the new revision in the same predicate. Runs inside E's outer
 * G transaction; never called by W.
 */
export function markWorkspaceSubmitted(
  handle: DatabaseHandle,
  input: MarkWorkspaceSubmittedInput,
): MarkWorkspaceSubmittedResult {
  return withTransaction(handle.sqlite, () => {
    const changed = handle.db
      .update(tailoringWorkspaces)
      .set({
        revision: input.observedRevision + 1,
        lastRequestId: input.requestId,
        lastSubmittedRevision: input.observedRevision + 1,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(tailoringWorkspaces.jobId, input.jobId),
          eq(tailoringWorkspaces.revision, input.observedRevision),
        ),
      )
      .run().changes;
    if (changed !== 1) {
      const current = readWorkspace(handle, input.jobId);
      return { ok: false, error: "conflict", currentRevision: current?.revision ?? 0 } as const;
    }
    return { ok: true, revision: input.observedRevision + 1 } as const;
  });
}

export interface InsertRequestInputsInput {
  requestId: string;
  workspaceRevision: number;
  submitHash: string;
  inputHash: string;
  candidateSnapshotId: string;
  focusJson: string;
  recommendationsJson: string;
  masterText: string;
  masterTextHash: string;
  projectionVersion: "master-text/1";
  now: string;
}

/**
 * Insert one immutable request-input extension row (E's G calls this
 * after the work item + generation request, in FK order). A snapshot
 * from another profile aborts with `INPUT_PROFILE_MISMATCH`; later
 * UPDATE/DELETE aborts with `INPUT_IMMUTABLE`.
 */
export function insertRequestInputs(handle: DatabaseHandle, input: InsertRequestInputsInput): void {
  withTransaction(handle.sqlite, () => {
    handle.db
      .insert(tailoringRequestInputs)
      .values({
        requestId: input.requestId,
        workspaceRevision: input.workspaceRevision,
        submitHash: input.submitHash,
        inputHash: input.inputHash,
        candidateSnapshotId: input.candidateSnapshotId,
        focusJson: input.focusJson,
        recommendationsJson: input.recommendationsJson,
        masterText: input.masterText,
        masterTextHash: input.masterTextHash,
        projectionVersion: input.projectionVersion,
        createdAt: input.now,
      })
      .run();
  });
}

/** Raw extension row for services that must re-verify frozen inputs. */
export function readRequestInputs(
  handle: DatabaseHandle,
  requestId: string,
): TailoringRequestInputs | null {
  const row = handle.db
    .select()
    .from(tailoringRequestInputs)
    .where(eq(tailoringRequestInputs.requestId, requestId))
    .get();
  return row ?? null;
}

export interface AppendProgressEventInput {
  requestId: string;
  workItemId: string;
  attemptId: string;
  seq: number;
  stage:
    | "PREPARING_INPUTS"
    | "WAITING_FOR_PROVIDER"
    | "VALIDATING_PROPOSAL"
    | "RENDERING_ARTIFACTS"
    | "PUBLISHING_RESULT";
  source: "provider" | "cached";
  /** Live lease token of the attempt; the fence trigger rechecks it. */
  leaseToken: string;
  /** Trusted service clock; sequence/time/source rules compare against it. */
  recordedAt: string;
}

/**
 * Append one fenced boundary event (F's worker calls this at real
 * stage boundaries under a live lease). The `v13_progress_fence`
 * trigger rejects duplicate/skipped/regressing/source-switch
 * events and any write whose lease tuple, attempt, or request is
 * not live (`LEASE_LOST`); UPDATE/DELETE abort with
 * `PROGRESS_IMMUTABLE`.
 */
export function appendProgressFenced(handle: DatabaseHandle, input: AppendProgressEventInput): void {
  withTransaction(handle.sqlite, () => {
    handle.db
      .insert(generationProgressEvents)
      .values({
        requestId: input.requestId,
        workItemId: input.workItemId,
        attemptId: input.attemptId,
        seq: input.seq,
        stage: input.stage,
        source: input.source,
        leaseToken: input.leaseToken,
        recordedAt: input.recordedAt,
      })
      .run();
  });
}

export interface InsertAssessmentInput {
  resumeVersionId: string;
  requestId: string;
  policyVersion: "assessment/1";
  masterTextHash: string;
  tailoredContentHash: string;
  /** Canonical measures JSON (G's calculator output, service-validated). */
  measuresJson: string;
  now: string;
}

/**
 * Insert one immutable generation-time assessment (G's publication
 * calls this with the version in one transaction). Any binding
 * disagreement — wrong request, master hash, content hash, or
 * candidate snapshot — aborts with `ASSESSMENT_BINDING_INVALID`;
 * later UPDATE/DELETE aborts with `ASSESSMENT_IMMUTABLE`.
 */
export function insertAssessment(handle: DatabaseHandle, input: InsertAssessmentInput): void {
  withTransaction(handle.sqlite, () => {
    handle.db
      .insert(resumeAssessments)
      .values({
        resumeVersionId: input.resumeVersionId,
        requestId: input.requestId,
        policyVersion: input.policyVersion,
        masterTextHash: input.masterTextHash,
        tailoredContentHash: input.tailoredContentHash,
        measuresJson: input.measuresJson,
        createdAt: input.now,
      })
      .run();
  });
}

/** Raw assessment row for the review read model (G parses measures strictly). */
export function readAssessment(
  handle: DatabaseHandle,
  resumeVersionId: string,
): ResumeAssessment | null {
  const row = handle.db
    .select()
    .from(resumeAssessments)
    .where(eq(resumeAssessments.resumeVersionId, resumeVersionId))
    .get();
  return row ?? null;
}

export interface RequestProgressSnapshot {
  requestId: string;
  jobId: string;
  status: string;
  workItemId: string | null;
  workState: string | null;
  currentAttemptId: string | null;
  leaseExpiresAt: string | null;
  /** Last successful renewal stamp while RUNNING (attempt liveness signal for F). */
  lastHeartbeatAt: string | null;
  /** Latest attempt id (null before the first claim); F's retry names it. */
  attemptId: string | null;
  attemptNumber: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  result: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  /**
   * Latest-attempt boundary events WITHOUT the lease token: F's
   * reply must never carry live credentials, and fencing rechecks
   * the token server-side in the trigger.
   */
  events: Array<Omit<GenerationProgressEvent, "leaseToken">>;
  resumeVersionId: string | null;
}

/**
 * Bounded progress read for F's progress API: at most 5 statements
 * regardless of history size (request; work item; latest attempt;
 * latest-attempt events; published version). Column-scoped: lease
 * tokens, queue payloads, and steering JSON are never selected, so
 * they cannot leak into F's reply. F parses `errorDetail` through
 * its allowlisted failure adapter (legacy text → INTERNAL).
 */
export function readRequestProgress(
  handle: DatabaseHandle,
  requestId: string,
): RequestProgressSnapshot | null {
  const request = handle.db
    .select({
      id: generationRequests.id,
      jobId: generationRequests.jobId,
      status: generationRequests.status,
      workItemId: generationRequests.workItemId,
    })
    .from(generationRequests)
    .where(eq(generationRequests.id, requestId))
    .get();
  if (request === undefined || request.workItemId === null) {
    return null;
  }
  const item = handle.db
    .select({
      state: workItems.state,
      currentAttemptId: workItems.currentAttemptId,
      leaseExpiresAt: workItems.leaseExpiresAt,
      updatedAt: workItems.updatedAt,
    })
    .from(workItems)
    .where(eq(workItems.id, request.workItemId))
    .get();
  if (item === undefined) {
    return null;
  }
  const attempt = handle.db
    .select({
      id: workAttempts.id,
      attemptNumber: workAttempts.attemptNumber,
      startedAt: workAttempts.startedAt,
      finishedAt: workAttempts.finishedAt,
      result: workAttempts.result,
      errorCode: workAttempts.errorCode,
      errorDetail: workAttempts.errorDetail,
      outputHash: workAttempts.outputHash,
    })
    .from(workAttempts)
    .where(eq(workAttempts.workItemId, request.workItemId))
    .orderBy(desc(workAttempts.attemptNumber))
    .get();
  const events =
    attempt === undefined
      ? []
      : handle.db
          .select({
            requestId: generationProgressEvents.requestId,
            workItemId: generationProgressEvents.workItemId,
            attemptId: generationProgressEvents.attemptId,
            seq: generationProgressEvents.seq,
            stage: generationProgressEvents.stage,
            source: generationProgressEvents.source,
            recordedAt: generationProgressEvents.recordedAt,
          })
          .from(generationProgressEvents)
          .where(
            and(
              eq(generationProgressEvents.requestId, requestId),
              eq(generationProgressEvents.attemptId, attempt.id),
            ),
          )
          .orderBy(asc(generationProgressEvents.seq))
          .all();
  // Committed-output resolution (WO-1.3-F): the request's own
  // version wins; otherwise the same job's version carrying the
  // latest attempt's output bytes covers dedupe convergence, where
  // a rerun reuses identical content instead of forking a version.
  // One statement either way, so the ≤5 read budget holds.
  const version = handle.db
    .select({ id: resumeVersions.id })
    .from(resumeVersions)
    .innerJoin(generationRequests, eq(resumeVersions.jobId, generationRequests.jobId))
    .where(
      and(
        eq(generationRequests.id, requestId),
        or(
          eq(resumeVersions.generationRequestId, requestId),
          attempt?.outputHash === null || attempt?.outputHash === undefined
            ? sql`false`
            : eq(resumeVersions.contentHash, attempt.outputHash),
        ),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${resumeVersions.generationRequestId} = ${requestId} THEN 0 ELSE 1 END`,
      desc(resumeVersions.createdAt),
    )
    .get();
  return {
    requestId: request.id,
    jobId: request.jobId,
    status: request.status,
    workItemId: request.workItemId,
    workState: item.state,
    currentAttemptId: item.currentAttemptId,
    leaseExpiresAt: item.leaseExpiresAt,
    lastHeartbeatAt: item.state === "RUNNING" ? item.updatedAt : null,
    attemptId: attempt?.id ?? null,
    attemptNumber: attempt?.attemptNumber ?? null,
    startedAt: attempt?.startedAt ?? null,
    finishedAt: attempt?.finishedAt ?? null,
    result: attempt?.result ?? null,
    errorCode: attempt?.errorCode ?? null,
    errorDetail: attempt?.errorDetail ?? null,
    events,
    resumeVersionId: version?.id ?? null,
  };
}
