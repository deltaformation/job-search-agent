import { and, eq, sql } from "drizzle-orm";
import type { DatabaseHandle } from "./client";
import { workItems } from "./schema/queue";
import { newId } from "./utils";
import { candidateSnapshots, type CandidateSnapshot } from "./schema/candidates";
import { jdSnapshots, jobAnalyses, type JdSnapshot, type JobAnalysis } from "./schema/analysis";
import { jobs } from "./schema/jobs";
import {
  resumeArtifacts,
  resumeClaimFacts,
  resumeClaims,
  resumeVersions,
  type ResumeArtifact,
  type ResumeClaim,
  type ResumeVersion,
} from "./schema/resumes";

/**
 * Row access for tailoring persistence. Single-statement helpers; the
 * caller composes them into short transactions (see
 * `src/tailoring/persist.ts`). State-machine and fencing decisions stay
 * out of this module.
 */

export interface TailoringJobRow {
  id: string;
  status: string;
  rowVersion: number;
  title: string | null;
  company: string | null;
  descriptionText: string | null;
  tailoringState: string;
  tailoringReasonCode: string | null;
  activeExtractionId: string | null;
  activeResumeVersionId: string | null;
}

export function getTailoringJob(handle: DatabaseHandle, jobId: string): TailoringJobRow | null {
  const row = handle.db
    .select({
      id: jobs.id,
      status: jobs.status,
      rowVersion: jobs.rowVersion,
      title: jobs.title,
      company: jobs.company,
      descriptionText: jobs.descriptionText,
      tailoringState: jobs.tailoringState,
      tailoringReasonCode: jobs.tailoringReasonCode,
      activeExtractionId: jobs.activeExtractionId,
      activeResumeVersionId: jobs.activeResumeVersionId,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .get();
  return row ?? null;
}

export function getCandidateSnapshotById(
  handle: DatabaseHandle,
  snapshotId: string,
): CandidateSnapshot | null {
  const row = handle.db
    .select()
    .from(candidateSnapshots)
    .where(eq(candidateSnapshots.id, snapshotId))
    .get();
  return row ?? null;
}

export function getJdSnapshotById(
  handle: DatabaseHandle,
  snapshotId: string,
): JdSnapshot | null {
  const row = handle.db.select().from(jdSnapshots).where(eq(jdSnapshots.id, snapshotId)).get();
  return row ?? null;
}

export function getAnalysisById(handle: DatabaseHandle, analysisId: string): JobAnalysis | null {
  const row = handle.db
    .select()
    .from(jobAnalyses)
    .where(eq(jobAnalyses.id, analysisId))
    .get();
  return row ?? null;
}

export function insertAnalysis(
  handle: DatabaseHandle,
  input: {
    jobId: string;
    jdSnapshotId: string;
    candidateSnapshotId: string;
    requirementsJson: string;
    gapsJson: string;
    provider: string | null;
    model: string | null;
    promptVersion: string;
    proposalSchemaVersion: string;
    inputHash: string | null;
    proposalHash: string | null;
    rationale: string | null;
    attemptJson: string | null;
  },
): JobAnalysis {
  const id = newId();
  handle.db.insert(jobAnalyses).values({ id, ...input }).run();
  const row = getAnalysisById(handle, id);
  if (row === null) {
    throw new Error("inserted analysis is not readable");
  }
  return row;
}

export interface LatestResumeVersion {
  id: string;
  version: number;
}

/** Latest version number for a job (max + 1 belongs to the caller's transaction). */
export function getLatestResumeVersion(
  handle: DatabaseHandle,
  jobId: string,
): LatestResumeVersion | null {
  const row = handle.db
    .select({ id: resumeVersions.id, version: resumeVersions.version })
    .from(resumeVersions)
    .where(eq(resumeVersions.jobId, jobId))
    .orderBy(sql`${resumeVersions.version} DESC`)
    .limit(1)
    .get();
  return row ?? null;
}

/** Content-hash dedupe: an identical version makes reruns idempotent. */
export function getResumeVersionByContentHash(
  handle: DatabaseHandle,
  jobId: string,
  contentHash: string,
): LatestResumeVersion | null {
  const row = handle.db
    .select({ id: resumeVersions.id, version: resumeVersions.version })
    .from(resumeVersions)
    .where(and(eq(resumeVersions.jobId, jobId), eq(resumeVersions.contentHash, contentHash)))
    .get();
  return row ?? null;
}

export function insertResumeVersion(
  handle: DatabaseHandle,
  input: {
    jobId: string;
    version: number;
    parentVersionId: string | null;
    analysisId: string;
    templateId: string;
    templateVersion: string;
    templateHash: string;
    rankerVersion: string;
    policyVersion: string;
    configVersion: string;
    renderSchemaVersion: string;
    contentJson: string;
    contentHash: string;
    reviewState: string;
  },
): ResumeVersion {
  const id = newId();
  handle.db.insert(resumeVersions).values({ id, ...input }).run();
  const row = handle.db
    .select()
    .from(resumeVersions)
    .where(eq(resumeVersions.id, id))
    .get();
  if (row === undefined) {
    throw new Error("inserted resume version is not readable");
  }
  return row;
}

export function insertResumeClaim(
  handle: DatabaseHandle,
  input: {
    resumeVersionId: string;
    claimText: string;
    requirementRef: string | null;
    derivationKind: string | null;
    derivationPayload: string | null;
  },
): ResumeClaim {
  const id = newId();
  handle.db.insert(resumeClaims).values({ id, ...input }).run();
  const row = handle.db.select().from(resumeClaims).where(eq(resumeClaims.id, id)).get();
  if (row === undefined) {
    throw new Error("inserted resume claim is not readable");
  }
  return row;
}

export function insertResumeClaimFact(
  handle: DatabaseHandle,
  input: { claimId: string; factId: string },
): void {
  handle.db.insert(resumeClaimFacts).values(input).run();
}

export function insertResumeArtifact(
  handle: DatabaseHandle,
  input: {
    resumeVersionId: string;
    kind: string;
    relativePath: string;
    mediaType: string;
    byteSize: number;
    sha256: string;
  },
): ResumeArtifact {
  const id = newId();
  handle.db.insert(resumeArtifacts).values({ id, ...input }).run();
  const row = handle.db.select().from(resumeArtifacts).where(eq(resumeArtifacts.id, id)).get();
  if (row === undefined) {
    throw new Error("inserted resume artifact is not readable");
  }
  return row;
}

export function getWorkItemByIdempotencyKey(
  handle: DatabaseHandle,
  idempotencyKey: string,
): { id: string } | null {
  const row = handle.db
    .select({ id: workItems.id })
    .from(workItems)
    .where(eq(workItems.idempotencyKey, idempotencyKey))
    .get();
  return row ?? null;
}

export function insertTailorWorkItem(
  handle: DatabaseHandle,
  input: { idempotencyKey: string; jobId: string; payloadJson: string; maxAttempts: number },
): string {
  const id = newId();
  handle.db
    .insert(workItems)
    .values({
      id,
      kind: "TAILOR",
      idempotencyKey: input.idempotencyKey,
      jobId: input.jobId,
      intakeItemId: null,
      payloadJson: input.payloadJson,
      maxAttempts: input.maxAttempts,
    })
    .onConflictDoNothing({ target: workItems.idempotencyKey })
    .run();
  return id;
}

/**
 * Compare-and-swap tailoring state: updates only when the row still
 * carries the observed version, so a concurrent board move fences the
 * write instead of being silently overwritten. Bumps `row_version` like
 * board moves so the two writers fence each other.
 */
export function casJobTailoringState(
  handle: DatabaseHandle,
  input: {
    jobId: string;
    rowVersion: number;
    tailoringState: string;
    reasonCode: string | null;
    activeResumeVersionId?: string | null;
    now: string;
  },
): boolean {
  const changed = handle.db
    .update(jobs)
    .set({
      tailoringState: input.tailoringState,
      tailoringReasonCode: input.reasonCode,
      ...(input.activeResumeVersionId === undefined
        ? {}
        : { activeResumeVersionId: input.activeResumeVersionId }),
      rowVersion: sql`${jobs.rowVersion} + 1`,
      updatedAt: input.now,
    })
    .where(and(eq(jobs.id, input.jobId), eq(jobs.rowVersion, input.rowVersion)))
    .run().changes;
  return changed === 1;
}
