import type { DatabaseHandle } from "../db/client";
import { getActiveProfileVersion } from "../db/candidates";
import {
  getGenerationRequest,
  getLiveGenerationRequest,
  updateGenerationRequestStatus,
} from "../db/generation";
import type { GenerationRequest } from "../db/schema/generation";
import {
  casJobTailoringState,
  getAnalysisByRequest,
  getJdSnapshotById,
  getLatestResumeVersion,
  getResumeVersionByContentHash,
  getTailoringJob,
  insertAnalysis,
  insertResumeArtifact,
  insertResumeClaim,
  insertResumeClaimFact,
  insertResumeVersion,
  type TailoringJobRow,
} from "../db/tailoring";
import { withTransaction } from "../db/transactions";
import { insertAssessment, readRequestInputs } from "../db/tailoringWorkspace";
import { verifyCapturedEvidence } from "../server/preparation";
import { canonicalJson } from "../domain/canonical";
import { ReasonCode, type TailoringState } from "../domain/enums";
import { planTailoringTransition } from "../domain/tailoring";
import { RENDER_CONFIG_VERSION } from "../resumes/config";
import { templateInfo } from "../resumes/template";
import { getOrCreateCandidateSnapshot } from "../server/candidates";
import {
  ANALYSIS_GAPS_SCHEMA_VERSION,
  ANALYSIS_REQUIREMENTS_SCHEMA_VERSION,
  TAILORING_POLICY_VERSION,
} from "./contract";
import { buildFailure, encodeFailureDetail } from "./failures";
import { computeAssessmentForAttach } from "../server/assessment";
import type { AcceptedProposal, OrchestrationSuccess } from "./orchestrate";
import { RANKING_POLICY_VERSION } from "./ranking";

/**
 * Tailoring persistence: short synchronous transactions around the
 * orchestration. Every write is fenced — the job row must still carry
 * the observed version, status, extraction pointer, and tailoring
 * state, otherwise the run aborts without attaching output (a rejected
 * or concurrently moved job can never receive a stale version).
 * Tailoring writes bump `row_version` exactly like board moves, so the
 * two writers fence each other.
 */

export interface RunStart {
  job: TailoringJobRow;
  fenceVersion: number;
  status: string;
  requestId: string;
  jdSnapshotId: string;
  candidateSnapshotId: string;
}

export type BeginRunResult =
  | { ok: true; start: RunStart }
  | {
      ok: false;
      error: "job-not-found" | "fenced" | "blocked" | "jd-stale" | "profile-gone";
      reason?: ReasonCode;
      detail: string;
    };

/**
 * Open a run against the pinned generation request: fence the job,
 * verify the pinned extraction is still active, resolve the pinned
 * profile version's candidate snapshot, and move the job to RUNNING
 * with the request in the same transaction. Nothing here follows live
 * pointers — a drifted extraction or a deleted profile version fails
 * the run instead of silently rebinding.
 */
export function beginTailorRun(
  handle: DatabaseHandle,
  input: { jobId: string; request: GenerationRequest; now: string },
): BeginRunResult {
  return withTransaction(handle.sqlite, () => {
    const request = input.request;
    const job = getTailoringJob(handle, input.jobId);
    if (job === null) {
      return {
        ok: false,
        error: "job-not-found",
        detail: `job '${input.jobId}' not found`,
      } as const;
    }
    if (job.status === "REJECTED") {
      return {
        ok: false,
        error: "fenced",
        detail: "job is REJECTED; queued tailoring cannot attach",
      } as const;
    }
    if (job.activeExtractionId !== request.extractionId) {
      return {
        ok: false,
        error: "jd-stale",
        detail:
          `request pins extraction '${request.extractionId}' but the job now points at ` +
          `'${job.activeExtractionId ?? "none"}'; start a new run against the current JD`,
      } as const;
    }
    const pinnedJd = getJdSnapshotById(handle, request.jdSnapshotId);
    if (pinnedJd === null || pinnedJd.jobId !== job.id || pinnedJd.extractionId !== request.extractionId) {
      return {
        ok: false,
        error: "jd-stale",
        detail: `pinned JD snapshot '${request.jdSnapshotId}' is missing or mismatched; start a new run`,
      } as const;
    }
    const planned = planTailoringTransition(job.tailoringState as TailoringState, {
      to: "RUNNING",
    });
    if (!planned.ok) {
      return {
        ok: false,
        error: "blocked",
        reason: "STALE_INPUT",
        detail: `tailoring cannot start from ${job.tailoringState}: ${planned.detail}`,
      } as const;
    }
    const candidate = getOrCreateCandidateSnapshot(handle, {
      profileVersionId: request.profileVersionId,
    });
    if (!candidate.ok) {
      if (candidate.error === "version-not-found") {
        return {
          ok: false,
          error: "profile-gone",
          detail:
            `pinned profile version '${request.profileVersionId}' no longer exists; ` +
            "re-activate the profile and start a new run",
        } as const;
      }
      return {
        ok: false,
        error: "blocked",
        reason: "STALE_INPUT",
        detail: `bound candidate snapshot is corrupt: ${candidate.detail}`,
      } as const;
    }
    const moved = casJobTailoringState(handle, {
      jobId: input.jobId,
      rowVersion: job.rowVersion,
      tailoringState: "RUNNING",
      reasonCode: null,
      now: input.now,
    });
    if (!moved) {
      return { ok: false, error: "fenced", detail: "job row changed before RUNNING" } as const;
    }
    updateGenerationRequestStatus(handle, {
      requestId: request.id,
      status: "RUNNING",
      startedAt: input.now,
      now: input.now,
    });
    return {
      ok: true,
      start: {
        job,
        fenceVersion: job.rowVersion + 1,
        status: job.status,
        requestId: request.id,
        jdSnapshotId: request.jdSnapshotId,
        candidateSnapshotId: candidate.snapshotId,
      },
    } as const;
  });
}

/**
 * Persist a validated proposal as an immutable analysis row, durably
 * linked to the exact request and attempt. Re-publishing the same
 * request (crash retry after commit) converges onto the existing row
 * instead of duplicating it.
 */
export function recordAnalysis(
  handle: DatabaseHandle,
  input: {
    jobId: string;
    jdSnapshotId: string;
    candidateSnapshotId: string;
    proposal: AcceptedProposal;
    providerId: string;
    promptVersion: string;
    proposalSchemaVersion: string;
    generationRequestId: string;
    workAttemptId: string;
  },
): string {
  return withTransaction(handle.sqlite, () => {
    const existing = getAnalysisByRequest(handle, input.generationRequestId);
    if (existing !== null) {
      return existing.id;
    }
    const row = insertAnalysis(handle, {
      jobId: input.jobId,
      jdSnapshotId: input.jdSnapshotId,
      candidateSnapshotId: input.candidateSnapshotId,
      requirementsJson: canonicalJson({
        schemaVersion: ANALYSIS_REQUIREMENTS_SCHEMA_VERSION,
        requirements: input.proposal.requirements,
      }),
      gapsJson: canonicalJson({
        schemaVersion: ANALYSIS_GAPS_SCHEMA_VERSION,
        gaps: input.proposal.gaps,
      }),
      provider: input.providerId,
      model: input.proposal.model,
      promptVersion: input.promptVersion,
      proposalSchemaVersion: input.proposalSchemaVersion,
      inputHash: input.proposal.inputHash,
      proposalHash: input.proposal.proposalHash,
      rationale: input.proposal.rationale,
      attemptJson: canonicalJson(input.proposal.attempt),
      generationRequestId: input.generationRequestId,
      workAttemptId: input.workAttemptId,
    });
    return row.id;
  });
}

export interface ReservedVersion {
  versionNumber: number;
  parentVersionId: string | null;
}

/** Read the next version reservation (re-verified inside the attach). */
export function nextResumeVersion(handle: DatabaseHandle, jobId: string): ReservedVersion {
  return withTransaction(handle.sqlite, () => {
    const latest = getLatestResumeVersion(handle, jobId);
    return { versionNumber: (latest?.version ?? 0) + 1, parentVersionId: latest?.id ?? null };
  });
}

export type AttachFence = "job" | "request" | "profile" | "version";

export type AttachVersionResult =
  | { ok: true; resumeVersionId: string; versionNumber: number; reused: boolean }
  | { ok: false; error: "fenced"; fence: AttachFence; detail: string }
  | { ok: false; error: "lease-lost"; detail: string }
  | { ok: false; error: "assessment-blocked"; detail: string };

/**
 * Attach a resume version: fence, dedupe by content hash, insert the
 * version with claims/citations/artifacts, and point the job at it.
 * Claim citations hit the membership trigger, so a fact outside the
 * bound snapshot aborts the whole transaction. The version carries the
 * request + attempt linkage, and the request flips to SUCCEEDED in the
 * same transaction — output and bookkeeping commit atomically.
 */
export function attachResumeVersion(
  handle: DatabaseHandle,
  input: {
    start: RunStart;
    extractionId: string;
    analysisId: string;
    result: OrchestrationSuccess;
    artifacts: Array<{
      kind: string;
      relativePath: string;
      mediaType: string;
      byteSize: number;
      sha256: string;
    }>;
    expectedVersion: ReservedVersion;
    workAttemptId: string;
    now: string;
    /**
     * WO-1.3-F live-lease fence (v3 runs only; v2 callers omit it).
     * Publication commits only while this exact attempt still holds
     * its lease — a stale worker's output dies here, write-free.
     */
    lease?: { workItemId: string; attemptId: string; leaseToken: string };
    /**
     * WO-1.3-F profile-active fence (v3 runs only). The bound
     * profile version must still be its profile's active version.
     */
    profileId?: string;
    profileVersionId?: string;
    /**
     * S2-D captured-evidence fence (edited-plan runs only,
     * exclusive with the active fence). The captured payload and
     * evidence digests must still verify; the version may no
     * longer be active — later Settings edits never strand
     * frozen work.
     */
    capturedEvidence?: {
      profileId: string;
      profileVersionId: string;
      profilePayloadHash: string;
      evidenceHash: string;
    };
  },
): AttachVersionResult {
  return withTransaction(handle.sqlite, () => {
    const job = getTailoringJob(handle, input.start.job.id);
    if (
      job === null ||
      job.rowVersion !== input.start.fenceVersion ||
      job.status !== input.start.status ||
      job.status === "REJECTED" ||
      job.activeExtractionId !== input.extractionId ||
      job.tailoringState !== "RUNNING"
    ) {
      return {
        ok: false,
        error: "fenced",
        fence: "job",
        detail: "job changed during tailoring; output not attached",
      } as const;
    }
    const request = getGenerationRequest(handle, input.start.requestId);
    if (request === null || request.status !== "RUNNING") {
      return {
        ok: false,
        error: "fenced",
        fence: "request",
        detail: "generation request is no longer running; output not attached",
      } as const;
    }
    if (input.lease !== undefined) {
      // Raw SQL: this module stays Drizzle-free per the purity rule.
      const live = handle.sqlite
        .prepare(
          `SELECT state, current_attempt_id AS currentAttemptId, lease_token AS leaseToken,
                  lease_expires_at AS leaseExpiresAt
           FROM work_items WHERE id = ?`,
        )
        .get(input.lease.workItemId) as
        | {
            state: string;
            currentAttemptId: string | null;
            leaseToken: string | null;
            leaseExpiresAt: string | null;
          }
        | undefined;
      const attempt = handle.sqlite
        .prepare("SELECT result FROM work_attempts WHERE id = ?")
        .get(input.lease.attemptId) as { result: string } | undefined;
      // ISO-8601 UTC stamps compare lexicographically; expiry is
      // exclusive — a lease expiring exactly now is already dead.
      if (
        live === undefined ||
        live.state !== "RUNNING" ||
        live.currentAttemptId !== input.lease.attemptId ||
        live.leaseToken !== input.lease.leaseToken ||
        live.leaseExpiresAt === null ||
        live.leaseExpiresAt <= input.now ||
        attempt === undefined ||
        attempt.result !== "RUNNING"
      ) {
        return {
          ok: false,
          error: "lease-lost",
          detail: "lease died before publication; output not attached",
        } as const;
      }
    }
    if (input.capturedEvidence !== undefined) {
      const evidence = verifyCapturedEvidence(handle, input.capturedEvidence);
      if (evidence.ok !== true) {
        return {
          ok: false,
          error: "fenced",
          fence: "profile",
          detail: "captured profile evidence no longer verifies; output not attached",
        } as const;
      }
    } else if (input.profileId !== undefined && input.profileVersionId !== undefined) {
      const active = getActiveProfileVersion(handle, input.profileId);
      if (active === null || active.id !== input.profileVersionId) {
        return {
          ok: false,
          error: "fenced",
          fence: "profile",
          detail: "bound profile version is no longer active; output not attached",
        } as const;
      }
    }
    const info = templateInfo();
    const existing = getResumeVersionByContentHash(handle, job.id, input.result.contentHash);
    // Dedupe converges only onto the job's live active version. A rerun
    // whose identical output matches a terminally reviewed version
    // (REVISION_REQUESTED, APPROVED, FAILED) — or a live version that is
    // no longer active — must mint a new child: the attach below never
    // moves the active pointer on the dedupe path, so converging anywhere
    // else would leave the job pointing at a version the review machine
    // can never advance. The child records the rerun honestly (new
    // analysis, parent link, new attempt) even when its bytes match.
    if (
      existing !== null &&
      existing.reviewState === "AWAITING_REVIEW" &&
      existing.id === job.activeResumeVersionId
    ) {
      const moved = casJobTailoringState(handle, {
        jobId: job.id,
        rowVersion: job.rowVersion,
        tailoringState: "AWAITING_REVIEW",
        reasonCode: null,
        now: input.now,
      });
      if (!moved) {
        return {
          ok: false,
          error: "fenced",
          fence: "job",
          detail: "job changed during dedupe attach",
        } as const;
      }
      updateGenerationRequestStatus(handle, {
        requestId: input.start.requestId,
        status: "SUCCEEDED",
        finishedAt: input.now,
        now: input.now,
      });
      return {
        ok: true,
        resumeVersionId: existing.id,
        versionNumber: existing.version,
        reused: true,
      } as const;
    }
    const latest = getLatestResumeVersion(handle, job.id);
    const versionNumber = (latest?.version ?? 0) + 1;
    if (
      versionNumber !== input.expectedVersion.versionNumber ||
      (latest?.id ?? null) !== input.expectedVersion.parentVersionId
    ) {
      return {
        ok: false,
        error: "fenced",
        fence: "version",
        detail: "a concurrent run reserved this version first",
      } as const;
    }
    const version = insertResumeVersion(handle, {
      jobId: job.id,
      version: versionNumber,
      parentVersionId: latest?.id ?? null,
      analysisId: input.analysisId,
      generationRequestId: input.start.requestId,
      workAttemptId: input.workAttemptId,
      templateId: info.template_id,
      templateVersion: info.template_version,
      templateHash: info.template_hash,
      rankerVersion: RANKING_POLICY_VERSION,
      policyVersion: TAILORING_POLICY_VERSION,
      configVersion: RENDER_CONFIG_VERSION,
      renderSchemaVersion: info.render_schema_version,
      contentJson: canonicalJson(input.result.content),
      contentHash: input.result.contentHash,
      reviewState: "AWAITING_REVIEW",
    });
    for (const claim of input.result.draft.claims) {
      const record = insertResumeClaim(handle, {
        resumeVersionId: version.id,
        claimText: typeof claim["text"] === "string" ? claim["text"] : String(claim["text"]),
        requirementRef: null,
        derivationKind:
          claim["generation_strategy"] === "derived_template" ? "derived_template" : null,
        derivationPayload:
          claim["derivation"] !== undefined && claim["derivation"] !== null
            ? canonicalJson(claim["derivation"])
            : null,
      });
      const factIds = claim["fact_ids"];
      if (Array.isArray(factIds)) {
        for (const factId of factIds) {
          if (typeof factId === "string") {
            insertResumeClaimFact(handle, { claimId: record.id, factId });
          }
        }
      }
    }
    for (const artifact of input.artifacts) {
      insertResumeArtifact(handle, {
        resumeVersionId: version.id,
        kind: artifact.kind,
        relativePath: artifact.relativePath,
        mediaType: artifact.mediaType,
        byteSize: artifact.byteSize,
        sha256: artifact.sha256,
      });
    }
    // G assessment/1: computed over the exact frozen inputs and the
    // canonical rendered bytes, persisted in the same atomic
    // publication. Legacy publishes (no frozen inputs row) skip;
    // integrity violations abort the attach with zero writes.
    const assessed = computeAssessmentForAttach(handle, {
      versionId: version.id,
      requestId: input.start.requestId,
      tailoredMarkdown: input.result.markdown.toString("utf8"),
      renderEvidence: input.result.renderEvidence ?? null,
      now: input.now,
    });
    if (assessed.status === "blocked") {
      return {
        ok: false,
        error: "assessment-blocked",
        detail: assessed.detail,
      } as const;
    }
    if (assessed.status === "assessed") {
      const frozenInputs = readRequestInputs(handle, input.start.requestId);
      if (frozenInputs === null) {
        throw new Error("internal: frozen request inputs vanished mid-attach");
      }
      insertAssessment(handle, {
        resumeVersionId: version.id,
        requestId: input.start.requestId,
        policyVersion: "assessment/1",
        masterTextHash: frozenInputs.masterTextHash,
        tailoredContentHash: input.result.contentHash,
        measuresJson: assessed.measuresJson,
        now: input.now,
      });
    }
    const moved = casJobTailoringState(handle, {
      jobId: job.id,
      rowVersion: job.rowVersion,
      tailoringState: "AWAITING_REVIEW",
      reasonCode: null,
      activeResumeVersionId: version.id,
      now: input.now,
    });
    if (!moved) {
      return {
        ok: false,
        error: "fenced",
        fence: "job",
        detail: "job changed during version attach",
      } as const;
    }
    updateGenerationRequestStatus(handle, {
      requestId: input.start.requestId,
      status: "SUCCEEDED",
      finishedAt: input.now,
      now: input.now,
    });
    return { ok: true, resumeVersionId: version.id, versionNumber, reused: false } as const;
  });
}

export type FailRunResult = { ok: true } | { ok: false; error: "fenced" };

/**
 * Record a terminal job outcome, giving up quietly when fenced. Plans
 * from the actual current state (begin-blocked runs never reached
 * RUNNING) and treats an identical outcome as idempotent success.
 */
export function failTailorRun(
  handle: DatabaseHandle,
  input: {
    jobId: string;
    rowVersion: number;
    to: "FAILED" | "BLOCKED";
    reasonCode: ReasonCode;
    now: string;
  },
): FailRunResult {
  return withTransaction(handle.sqlite, () => {
    const job = getTailoringJob(handle, input.jobId);
    if (job === null || job.rowVersion !== input.rowVersion) {
      return { ok: false, error: "fenced" } as const;
    }
    if (job.tailoringState === input.to && job.tailoringReasonCode === input.reasonCode) {
      return { ok: true } as const;
    }
    const planned = planTailoringTransition(job.tailoringState as TailoringState, {
      to: input.to,
      reasonCode: input.reasonCode,
    });
    if (!planned.ok) {
      return { ok: false, error: "fenced" } as const;
    }
    const moved = casJobTailoringState(handle, {
      jobId: input.jobId,
      rowVersion: input.rowVersion,
      tailoringState: input.to,
      reasonCode: input.reasonCode,
      now: input.now,
    });
    if (!moved) {
      return { ok: false, error: "fenced" } as const;
    }
    return { ok: true } as const;
  });
}

/**
 * Fail a request and its job together: the job moves to the terminal
 * outcome and the request records the same failure in one transaction,
 * so neither can strand the other.
 */
export function failRequestRun(
  handle: DatabaseHandle,
  input: {
    jobId: string;
    requestId: string;
    rowVersion: number;
    to: "FAILED" | "BLOCKED";
    reasonCode: ReasonCode;
    errorDetail: string;
    now: string;
  },
): FailRunResult {
  return withTransaction(handle.sqlite, () => {
    const failed = failTailorRun(handle, {
      jobId: input.jobId,
      rowVersion: input.rowVersion,
      to: input.to,
      reasonCode: input.reasonCode,
      now: input.now,
    });
    if (!failed.ok) {
      return failed;
    }
    updateGenerationRequestStatus(handle, {
      requestId: input.requestId,
      status: "FAILED",
      errorCode: input.reasonCode,
      errorDetail: input.errorDetail,
      finishedAt: input.now,
      now: input.now,
    });
    return { ok: true } as const;
  });
}

export interface ReleaseStaleRunResult {
  requestFailed: true;
  /** False when the job had already moved on (fenced). */
  jobReleased: boolean;
}

/**
 * Retire a request whose pinned extraction is stale: the request fails
 * with the stale detail and the job returns to READY so the human can
 * start a fresh run against the current JD. A job that already moved
 * (concurrent human action) is left alone — only the request fails.
 */
export function releaseStaleRun(
  handle: DatabaseHandle,
  input: {
    jobId: string;
    requestId: string;
    rowVersion: number;
    detail: string;
    now: string;
    /**
     * Request error code (WO-1.3-F): v3 callers persist the precise
     * Failure code (`INPUT_STALE`) with a versioned detail envelope;
     * v2 callers keep the legacy `STALE_INPUT` prose pair.
     */
    errorCode?: string;
  },
): ReleaseStaleRunResult {
  return withTransaction(handle.sqlite, () => {
    const job = getTailoringJob(handle, input.jobId);
    let jobReleased = false;
    if (job !== null && job.rowVersion === input.rowVersion && job.tailoringState === "PENDING") {
      const planned = planTailoringTransition(job.tailoringState as TailoringState, {
        to: "READY",
      });
      if (planned.ok) {
        jobReleased = casJobTailoringState(handle, {
          jobId: input.jobId,
          rowVersion: input.rowVersion,
          tailoringState: "READY",
          reasonCode: null,
          now: input.now,
        });
      }
    }
    updateGenerationRequestStatus(handle, {
      requestId: input.requestId,
      status: "FAILED",
      errorCode: input.errorCode ?? "STALE_INPUT",
      errorDetail: input.detail,
      finishedAt: input.now,
      now: input.now,
    });
    return { requestFailed: true as const, jobReleased };
  });
}

/**
 * Reopen a run after a dead attempt (§9 recovery). A freshly claimed
 * item whose job is still RUNNING means the previous attempt died
 * (worker crash, lease expiry, retryable failure) without a terminal
 * job move — the only writer that could own RUNNING is gone, because
 * the live request admits exactly one live item and this claim holds
 * it. Reset RUNNING→PENDING so `beginTailorRun` can reopen; the
 * `row_version` bump fences any zombie publish from the dead attempt.
 * No-op unless the job is exactly RUNNING.
 */
export function reopenTailorRun(
  handle: DatabaseHandle,
  input: { jobId: string; now: string },
): { reopened: boolean } {
  return withTransaction(handle.sqlite, () => {
    const job = getTailoringJob(handle, input.jobId);
    if (job === null || job.tailoringState !== "RUNNING") {
      return { reopened: false };
    }
    const moved = casJobTailoringState(handle, {
      jobId: input.jobId,
      rowVersion: job.rowVersion,
      tailoringState: "PENDING",
      reasonCode: null,
      now: input.now,
    });
    return { reopened: moved };
  });
}

export type TerminalizeExhaustedResult =
  | { ok: true; terminalized: boolean }
  | { ok: false; error: "fenced" };

/**
 * Terminalize a run whose queue attempts are exhausted (§9). Called by
 * the dispatcher for TAILOR items stale recovery finished FAILED: the
 * job can only be stuck RUNNING (every handler-side terminal path
 * moves it), so move RUNNING→FAILED and fail the live request with an
 * actionable detail. A job that already moved is left alone.
 */
export function terminalizeExhaustedRun(
  handle: DatabaseHandle,
  input: { jobId: string; workItemId: string; attempts: number; now: string },
): TerminalizeExhaustedResult {
  return withTransaction(handle.sqlite, () => {
    const job = getTailoringJob(handle, input.jobId);
    if (job === null || job.tailoringState !== "RUNNING") {
      return { ok: true, terminalized: false };
    }
    const live = getLiveGenerationRequest(handle, input.jobId);
    const detail =
      `tailoring attempts exhausted (${input.attempts} attempts, ` +
      `last item '${input.workItemId}'); the worker never finished a run — ` +
      "start generation again";
    // WO-1.3-F: v3 requests (those with an immutable input extension)
    // record the exhaustion as a versioned LEASE_LOST failure so Step
    // 3 and transaction R classify from actual codes; v2 prose stays.
    const liveIsV3 = live !== null && readRequestInputs(handle, live.id) !== null;
    const exhaustedDetail = liveIsV3
      ? encodeFailureDetail(buildFailure("LEASE_LOST", { stage: null, occurredAt: input.now }))
      : detail;
    if (live === null) {
      const planned = planTailoringTransition(job.tailoringState as TailoringState, {
        to: "FAILED",
        reasonCode: "TIMEOUT",
      });
      if (!planned.ok) {
        return { ok: false, error: "fenced" } as const;
      }
      const moved = casJobTailoringState(handle, {
        jobId: input.jobId,
        rowVersion: job.rowVersion,
        tailoringState: "FAILED",
        reasonCode: "TIMEOUT",
        now: input.now,
      });
      return moved
        ? ({ ok: true, terminalized: true } as const)
        : ({ ok: false, error: "fenced" } as const);
    }
    const failed = failRequestRun(handle, {
      jobId: input.jobId,
      requestId: live.id,
      rowVersion: job.rowVersion,
      to: "FAILED",
      reasonCode: liveIsV3 ? "LEASE_LOST" : "TIMEOUT",
      errorDetail: exhaustedDetail,
      now: input.now,
    });
    if (!failed.ok) {
      return { ok: false, error: "fenced" } as const;
    }
    return { ok: true, terminalized: true } as const;
  });
}
