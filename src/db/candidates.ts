import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { DatabaseHandle } from "./client";
import {
  candidateFacts,
  candidateProfileVersions,
  candidateProfiles,
  candidateSnapshotFacts,
  candidateSnapshots,
  jdSnapshots,
  jobExtractions,
  jobs,
} from "./schema";
import { newId } from "./utils";

/**
 * Candidate repositories: thin synchronous row operations for the local
 * profile root, reviewed versions, verified facts, and immutable
 * candidate/JD snapshots. Transaction-agnostic — callers (the R4-A command
 * service) own the short transaction via `withTransaction`.
 */

export const LOCAL_PROFILE_ID = "local";

export interface ProfileVersionRow {
  id: string;
  profileId: string;
  version: number;
  payloadJson: string;
  payloadHash: string;
  schemaVersion: string;
  activatedAt: string | null;
  createdAt: string;
}

export interface FactRow {
  factId: string;
  profileVersionId: string;
  kind: string;
  statement: string;
  evidenceJson: string | null;
  verification: string;
  source: string | null;
  createdAt: string;
}

export interface CandidateSnapshotRow {
  id: string;
  profileVersionId: string;
  canonicalJson: string;
  schemaVersion: string;
  sha256: string;
  createdAt: string;
}

export interface JdSnapshotRow {
  id: string;
  jobId: string;
  extractionId: string;
  jdText: string;
  canonicalSha256: string;
  createdAt: string;
}

/** Ensure the single local profile root exists; returns its id. */
export function ensureLocalProfile(handle: DatabaseHandle): string {
  handle.db
    .insert(candidateProfiles)
    .values({ id: LOCAL_PROFILE_ID })
    .onConflictDoNothing()
    .run();
  return LOCAL_PROFILE_ID;
}

/** Next version number for the profile (max + 1 inside the caller's transaction). */
export function nextProfileVersionNumber(handle: DatabaseHandle): number {
  const row = handle.db
    .select({ maxVersion: sql<number | null>`max(${candidateProfileVersions.version})` })
    .from(candidateProfileVersions)
    .where(eq(candidateProfileVersions.profileId, LOCAL_PROFILE_ID))
    .get();
  return (row?.maxVersion ?? 0) + 1;
}

export function insertProfileVersion(
  handle: DatabaseHandle,
  input: {
    version: number;
    payloadJson: string;
    payloadHash: string;
    schemaVersion: string;
  },
): ProfileVersionRow {
  const id = newId();
  handle.db
    .insert(candidateProfileVersions)
    .values({
      id,
      profileId: LOCAL_PROFILE_ID,
      version: input.version,
      payloadJson: input.payloadJson,
      payloadHash: input.payloadHash,
      schemaVersion: input.schemaVersion,
    })
    .run();
  const row = getProfileVersion(handle, id);
  if (row === null) {
    throw new Error("inserted profile version is not readable");
  }
  return row;
}

export function getProfileVersion(
  handle: DatabaseHandle,
  versionId: string,
): ProfileVersionRow | null {
  const row = handle.db
    .select()
    .from(candidateProfileVersions)
    .where(eq(candidateProfileVersions.id, versionId))
    .get();
  return row ?? null;
}

export function getProfileVersionByNumber(
  handle: DatabaseHandle,
  version: number,
): ProfileVersionRow | null {
  const row = handle.db
    .select()
    .from(candidateProfileVersions)
    .where(
      and(
        eq(candidateProfileVersions.profileId, LOCAL_PROFILE_ID),
        eq(candidateProfileVersions.version, version),
      ),
    )
    .get();
  return row ?? null;
}

export function listProfileVersions(handle: DatabaseHandle): ProfileVersionRow[] {
  return handle.db
    .select()
    .from(candidateProfileVersions)
    .where(eq(candidateProfileVersions.profileId, LOCAL_PROFILE_ID))
    .orderBy(asc(candidateProfileVersions.version))
    .all();
}

export function getActiveProfileVersion(handle: DatabaseHandle): ProfileVersionRow | null {
  const row = handle.db
    .select()
    .from(candidateProfileVersions)
    .where(
      and(
        eq(candidateProfileVersions.profileId, LOCAL_PROFILE_ID),
        isNotNull(candidateProfileVersions.activatedAt),
      ),
    )
    .get();
  return row ?? null;
}

/**
 * Activate one version and deactivate the rest. Returns false when the id
 * does not exist; the partial unique index keeps this race-safe.
 */
export function activateProfileVersion(
  handle: DatabaseHandle,
  versionId: string,
  now: string,
): boolean {
  const target = getProfileVersion(handle, versionId);
  if (target === null) {
    return false;
  }
  handle.db
    .update(candidateProfileVersions)
    .set({ activatedAt: null })
    .where(
      and(
        eq(candidateProfileVersions.profileId, LOCAL_PROFILE_ID),
        isNotNull(candidateProfileVersions.activatedAt),
      ),
    )
    .run();
  handle.db
    .update(candidateProfileVersions)
    .set({ activatedAt: now })
    .where(eq(candidateProfileVersions.id, versionId))
    .run();
  return true;
}

export function getFact(handle: DatabaseHandle, factId: string): FactRow | null {
  const row = handle.db
    .select()
    .from(candidateFacts)
    .where(eq(candidateFacts.factId, factId))
    .get();
  return (row ?? null) as FactRow | null;
}

/** Facts owned by one version, ordered by `fact_id` (oracle parity). */
export function listFactsByVersion(
  handle: DatabaseHandle,
  profileVersionId: string,
): FactRow[] {
  return handle.db
    .select()
    .from(candidateFacts)
    .where(eq(candidateFacts.profileVersionId, profileVersionId))
    .orderBy(asc(candidateFacts.factId))
    .all() as FactRow[];
}

export function insertFact(
  handle: DatabaseHandle,
  input: {
    factId: string;
    profileVersionId: string;
    kind: string;
    statement: string;
    evidenceJson: string | null;
    verification: "PENDING" | "APPROVED" | "REJECTED";
    source: string | null;
  },
): void {
  handle.db.insert(candidateFacts).values(input).run();
}

/**
 * Review one draft fact. Only PENDING facts move; approved rows are frozen
 * by trigger, so approval is a one-way, human-attributed step.
 */
export function setFactVerification(
  handle: DatabaseHandle,
  factId: string,
  to: "APPROVED" | "REJECTED",
): boolean {
  const current = getFact(handle, factId);
  if (current === null || current.verification !== "PENDING") {
    return false;
  }
  handle.db
    .update(candidateFacts)
    .set({ verification: to })
    .where(eq(candidateFacts.factId, factId))
    .run();
  return true;
}

export function insertCandidateSnapshot(
  handle: DatabaseHandle,
  input: {
    profileVersionId: string;
    canonicalJson: string;
    schemaVersion: string;
    sha256: string;
  },
): CandidateSnapshotRow {
  const id = newId();
  handle.db
    .insert(candidateSnapshots)
    .values({ id, ...input })
    .run();
  const row = handle.db
    .select()
    .from(candidateSnapshots)
    .where(eq(candidateSnapshots.id, id))
    .get();
  if (row === undefined) {
    throw new Error("inserted candidate snapshot is not readable");
  }
  return row;
}

export function getCandidateSnapshotByHash(
  handle: DatabaseHandle,
  profileVersionId: string,
  sha256: string,
): CandidateSnapshotRow | null {
  const row = handle.db
    .select()
    .from(candidateSnapshots)
    .where(
      and(
        eq(candidateSnapshots.profileVersionId, profileVersionId),
        eq(candidateSnapshots.sha256, sha256),
      ),
    )
    .get();
  return row ?? null;
}

export function insertSnapshotFactMembership(
  handle: DatabaseHandle,
  snapshotId: string,
  factId: string,
): void {
  handle.db
    .insert(candidateSnapshotFacts)
    .values({ snapshotId, factId })
    .onConflictDoNothing()
    .run();
}

/** Approved member facts of a snapshot, ordered by `fact_id`. */
export function listSnapshotFacts(
  handle: DatabaseHandle,
  snapshotId: string,
): FactRow[] {
  return handle.db
    .select({
      factId: candidateFacts.factId,
      profileVersionId: candidateFacts.profileVersionId,
      kind: candidateFacts.kind,
      statement: candidateFacts.statement,
      evidenceJson: candidateFacts.evidenceJson,
      verification: candidateFacts.verification,
      source: candidateFacts.source,
      createdAt: candidateFacts.createdAt,
    })
    .from(candidateSnapshotFacts)
    .innerJoin(candidateFacts, eq(candidateSnapshotFacts.factId, candidateFacts.factId))
    .where(eq(candidateSnapshotFacts.snapshotId, snapshotId))
    .orderBy(asc(candidateFacts.factId))
    .all() as FactRow[];
}

export function insertJdSnapshot(
  handle: DatabaseHandle,
  input: { jobId: string; extractionId: string; jdText: string; canonicalSha256: string },
): JdSnapshotRow {
  const id = newId();
  handle.db
    .insert(jdSnapshots)
    .values({ id, ...input })
    .run();
  const row = handle.db
    .select()
    .from(jdSnapshots)
    .where(eq(jdSnapshots.id, id))
    .get();
  if (row === undefined) {
    throw new Error("inserted JD snapshot is not readable");
  }
  return row;
}

export function getJdSnapshotByHash(
  handle: DatabaseHandle,
  jobId: string,
  canonicalSha256: string,
): JdSnapshotRow | null {
  const row = handle.db
    .select()
    .from(jdSnapshots)
    .where(
      and(eq(jdSnapshots.jobId, jobId), eq(jdSnapshots.canonicalSha256, canonicalSha256)),
    )
    .get();
  return row ?? null;
}

export interface JobDescriptionPointer {
  jobId: string;
  descriptionText: string | null;
  activeExtractionId: string | null;
}

export function getJobDescriptionPointer(
  handle: DatabaseHandle,
  jobId: string,
): JobDescriptionPointer | null {
  const row = handle.db
    .select({
      jobId: jobs.id,
      descriptionText: jobs.descriptionText,
      activeExtractionId: jobs.activeExtractionId,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .get();
  return row ?? null;
}

/** Owning job of an extraction, or null when the extraction is unknown. */
export function getExtractionJobId(
  handle: DatabaseHandle,
  extractionId: string,
): string | null {
  const row = handle.db
    .select({ jobId: jobExtractions.jobId })
    .from(jobExtractions)
    .where(eq(jobExtractions.id, extractionId))
    .get();
  return row?.jobId ?? null;
}
