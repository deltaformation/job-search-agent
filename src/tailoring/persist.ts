import type { DatabaseHandle } from "../db/client";
import {
  casJobTailoringState,
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
import { canonicalJson } from "../domain/canonical";
import { ReasonCode, type TailoringState } from "../domain/enums";
import { planTailoringTransition } from "../domain/tailoring";
import { RENDER_CONFIG_VERSION } from "../resumes/config";
import { templateInfo } from "../resumes/template";
import { resolveCurrentSnapshots } from "../server/candidates";
import {
  ANALYSIS_GAPS_SCHEMA_VERSION,
  ANALYSIS_REQUIREMENTS_SCHEMA_VERSION,
  TAILORING_POLICY_VERSION,
} from "./contract";
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
  jdSnapshotId: string;
  candidateSnapshotId: string;
}

export type BeginRunResult =
  | { ok: true; start: RunStart }
  | {
      ok: false;
      error: "job-not-found" | "fenced" | "blocked";
      reason?: ReasonCode;
      detail: string;
    };

/**
 * Open a run: fence the job, resolve current snapshots, and move the
 * job to RUNNING. Snapshot creation joins this transaction nest-safely.
 */
export function beginTailorRun(
  handle: DatabaseHandle,
  input: { jobId: string; extractionId: string; now: string },
): BeginRunResult {
  return withTransaction(handle.sqlite, () => {
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
    if (job.activeExtractionId !== input.extractionId) {
      return {
        ok: false,
        error: "fenced",
        detail: "a newer extraction superseded this run's payload",
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
    const snapshots = resolveCurrentSnapshots(handle, input.jobId);
    if (!snapshots.ok) {
      if (snapshots.error === "job-not-found") {
        return { ok: false, error: "job-not-found", detail: "job vanished mid-run" } as const;
      }
      return {
        ok: false,
        error: "blocked",
        reason: snapshots.reason,
        detail: snapshots.detail,
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
    return {
      ok: true,
      start: {
        job,
        fenceVersion: job.rowVersion + 1,
        status: job.status,
        jdSnapshotId: snapshots.jdSnapshotId,
        candidateSnapshotId: snapshots.candidateSnapshotId,
      },
    } as const;
  });
}

/** Persist a validated proposal as an immutable analysis row. */
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
  },
): string {
  return withTransaction(handle.sqlite, () => {
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

export type AttachVersionResult =
  | { ok: true; resumeVersionId: string; versionNumber: number; reused: boolean }
  | { ok: false; error: "fenced"; detail: string };

/**
 * Attach a resume version: fence, dedupe by content hash, insert the
 * version with claims/citations/artifacts, and point the job at it.
 * Claim citations hit the membership trigger, so a fact outside the
 * bound snapshot aborts the whole transaction.
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
    now: string;
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
        detail: "job changed during tailoring; output not attached",
      } as const;
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
        return { ok: false, error: "fenced", detail: "job changed during dedupe attach" } as const;
      }
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
        detail: "a concurrent run reserved this version first",
      } as const;
    }
    const version = insertResumeVersion(handle, {
      jobId: job.id,
      version: versionNumber,
      parentVersionId: latest?.id ?? null,
      analysisId: input.analysisId,
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
    const moved = casJobTailoringState(handle, {
      jobId: job.id,
      rowVersion: job.rowVersion,
      tailoringState: "AWAITING_REVIEW",
      reasonCode: null,
      activeResumeVersionId: version.id,
      now: input.now,
    });
    if (!moved) {
      return { ok: false, error: "fenced", detail: "job changed during version attach" } as const;
    }
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
