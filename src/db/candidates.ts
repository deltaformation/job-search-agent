import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  CAREER_PROFILE_SCHEMA_VERSION,
  CareerProfileV1,
  CreateCareerProfileInputV1,
  UpdateCareerProfileInputV1,
  WORK_PREFERENCES_SCHEMA_VERSION,
  WorkPreferencesInputV1,
  WorkPreferencesV1,
} from "../domain/candidate";
import { canonicalJson } from "../domain/canonical";
import type { DatabaseHandle } from "./client";
import {
  candidateFacts,
  candidateProfileVersions,
  candidateProfiles,
  candidateSnapshotFacts,
  candidateSnapshots,
  candidateSources,
  jdSnapshots,
  jobExtractions,
  jobs,
} from "./schema";
import { newId } from "./utils";

/**
 * Candidate repositories: thin synchronous row operations for career
 * profiles, reviewed versions, verified facts, and immutable
 * candidate/JD snapshots. Transaction-agnostic — callers own the short
 * transaction via `withTransaction`.
 *
 * R-ADR-012: many named profiles share this table, each with its own
 * version lineage and at most one active version; one profile is the
 * default. Version helpers accept an optional `profileId` and resolve to
 * the default profile when omitted, so single-profile callers behave
 * exactly as before.
 */

export const LOCAL_PROFILE_ID = "local";
export const DEFAULT_PROFILE_NAME = "default";
export const DEFAULT_PROFILE_DISPLAY_NAME = "Primary Profile";

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

export interface SourceRow {
  id: string;
  profileId: string;
  profileVersionId: string;
  relativePath: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  origin: string;
  originDetailJson: string | null;
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
  provenanceJson: string | null;
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

/**
 * Ensure the legacy local profile root exists; returns its id. Backwards
 * compatibility for single-profile flows: the row carries the same
 * name/display/default the 0005 migration backfills.
 */
export function ensureLocalProfile(handle: DatabaseHandle): string {
  handle.db
    .insert(candidateProfiles)
    .values({
      id: LOCAL_PROFILE_ID,
      name: DEFAULT_PROFILE_NAME,
      displayName: DEFAULT_PROFILE_DISPLAY_NAME,
      isDefault: true,
    })
    .onConflictDoNothing()
    .run();
  return LOCAL_PROFILE_ID;
}

export interface ProfileRow {
  id: string;
  name: string;
  displayName: string;
  isDefault: boolean;
  workPreferencesJson: string | null;
  executiveNarrative: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProfileInput {
  name: string;
  displayName: string;
  workPreferences?: z.input<typeof WorkPreferencesInputV1>;
  executiveNarrative?: string;
  isDefault?: boolean;
}

export interface UpdateProfileInput {
  displayName?: string;
  workPreferences?: z.input<typeof WorkPreferencesInputV1> | null;
  executiveNarrative?: string | null;
}

function stampPreferencesJson(input: z.input<typeof WorkPreferencesInputV1>): string {
  const validated = WorkPreferencesV1.parse({
    ...WorkPreferencesInputV1.parse(input),
    schemaVersion: WORK_PREFERENCES_SCHEMA_VERSION,
  });
  return canonicalJson(validated);
}

/** Compose the validated profile view; throws on corrupt stored JSON. */
function toCareerProfile(row: ProfileRow): z.infer<typeof CareerProfileV1> {
  const workPreferences =
    row.workPreferencesJson === null
      ? null
      : WorkPreferencesV1.parse(JSON.parse(row.workPreferencesJson) as unknown);
  return CareerProfileV1.parse({
    schemaVersion: CAREER_PROFILE_SCHEMA_VERSION,
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    isDefault: row.isDefault,
    workPreferences,
    executiveNarrative: row.executiveNarrative,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function getProfileRow(handle: DatabaseHandle, id: string): ProfileRow | null {
  const row = handle.db
    .select()
    .from(candidateProfiles)
    .where(eq(candidateProfiles.id, id))
    .get();
  return (row ?? null) as ProfileRow | null;
}

function getProfileRowByName(handle: DatabaseHandle, name: string): ProfileRow | null {
  const row = handle.db
    .select()
    .from(candidateProfiles)
    .where(eq(candidateProfiles.name, name))
    .get();
  return (row ?? null) as ProfileRow | null;
}

/** Every career profile, alphabetical by unique name (total, stable order). */
export function listProfiles(handle: DatabaseHandle): z.infer<typeof CareerProfileV1>[] {
  return handle.db
    .select()
    .from(candidateProfiles)
    .orderBy(asc(candidateProfiles.name))
    .all()
    .map((row) => toCareerProfile(row as ProfileRow));
}

/**
 * One profile by id, falling back to an exact name match when no id
 * matches. Ids (UUIDs) and slugs cannot collide in practice; the id
 * lookup wins by construction.
 */
export function getProfile(
  handle: DatabaseHandle,
  idOrName: string,
): z.infer<typeof CareerProfileV1> | null {
  const byId = getProfileRow(handle, idOrName);
  if (byId !== null) {
    return toCareerProfile(byId);
  }
  const byName = getProfileRowByName(handle, idOrName);
  return byName === null ? null : toCareerProfile(byName);
}

/** The default profile, or null when none is set. */
export function getDefaultProfile(handle: DatabaseHandle): z.infer<typeof CareerProfileV1> | null {
  const row = handle.db
    .select()
    .from(candidateProfiles)
    .where(eq(candidateProfiles.isDefault, true))
    .get();
  return row === undefined ? null : toCareerProfile(row as ProfileRow);
}

/** Explicit profile id, else the default profile, else the legacy root. */
function resolveProfileId(handle: DatabaseHandle, profileId?: string): string {
  if (profileId !== undefined) {
    return profileId;
  }
  return getDefaultProfile(handle)?.id ?? LOCAL_PROFILE_ID;
}

/**
 * Create a career profile. The first profile (or an explicit `isDefault`)
 * becomes the default, clearing any previous one. Throws `ZodError` on
 * invalid input and a UNIQUE violation on a duplicate name.
 */
export function createProfile(
  handle: DatabaseHandle,
  rawInput: CreateProfileInput,
  options: { id?: string } = {},
): z.infer<typeof CareerProfileV1> {
  const input = CreateCareerProfileInputV1.parse(rawInput);
  const makeDefault = input.isDefault ?? getDefaultProfile(handle) === null;
  if (makeDefault) {
    handle.db
      .update(candidateProfiles)
      .set({ isDefault: false })
      .where(eq(candidateProfiles.isDefault, true))
      .run();
  }
  const id = options.id ?? newId();
  handle.db
    .insert(candidateProfiles)
    .values({
      id,
      name: input.name,
      displayName: input.displayName,
      isDefault: makeDefault,
      workPreferencesJson:
        input.workPreferences === undefined ? null : stampPreferencesJson(input.workPreferences),
      executiveNarrative: input.executiveNarrative ?? null,
    })
    .run();
  const created = getProfileRow(handle, id);
  if (created === null) {
    throw new Error("inserted career profile is not readable");
  }
  return toCareerProfile(created);
}

/**
 * Update mutable profile metadata (`updated_at` always advances on write).
 * Identity (`id`, `name`) is frozen by trigger. Returns null for unknown
 * ids; a field set to null clears it.
 */
export function updateProfile(
  handle: DatabaseHandle,
  id: string,
  rawInput: UpdateProfileInput,
  now: string,
): z.infer<typeof CareerProfileV1> | null {
  const existing = getProfileRow(handle, id);
  if (existing === null) {
    return null;
  }
  const input = UpdateCareerProfileInputV1.parse(rawInput);
  const patch: Partial<ProfileRow> & { updatedAt: string } = { updatedAt: now };
  if (input.displayName !== undefined) {
    patch.displayName = input.displayName;
  }
  if (input.workPreferences !== undefined) {
    patch.workPreferencesJson =
      input.workPreferences === null ? null : stampPreferencesJson(input.workPreferences);
  }
  if (input.executiveNarrative !== undefined) {
    patch.executiveNarrative = input.executiveNarrative;
  }
  handle.db
    .update(candidateProfiles)
    .set(patch)
    .where(eq(candidateProfiles.id, id))
    .run();
  const updated = getProfileRow(handle, id);
  if (updated === null) {
    throw new Error("updated career profile is not readable");
  }
  return toCareerProfile(updated);
}

/**
 * Move the default marker to one profile. Returns false when the id is
 * unknown; the partial unique index keeps this race-safe.
 */
export function setDefaultProfile(handle: DatabaseHandle, id: string): boolean {
  if (getProfileRow(handle, id) === null) {
    return false;
  }
  handle.db
    .update(candidateProfiles)
    .set({ isDefault: false })
    .where(eq(candidateProfiles.isDefault, true))
    .run();
  handle.db
    .update(candidateProfiles)
    .set({ isDefault: true })
    .where(eq(candidateProfiles.id, id))
    .run();
  return true;
}

/** Next version number for one profile (max + 1 inside the caller's transaction). */
export function nextProfileVersionNumber(handle: DatabaseHandle, profileId?: string): number {
  const row = handle.db
    .select({ maxVersion: sql<number | null>`max(${candidateProfileVersions.version})` })
    .from(candidateProfileVersions)
    .where(eq(candidateProfileVersions.profileId, resolveProfileId(handle, profileId)))
    .get();
  return (row?.maxVersion ?? 0) + 1;
}

export function insertProfileVersion(
  handle: DatabaseHandle,
  input: {
    id?: string;
    version: number;
    payloadJson: string;
    payloadHash: string;
    schemaVersion: string;
    profileId?: string;
  },
): ProfileVersionRow {
  const id = input.id ?? newId();
  handle.db
    .insert(candidateProfileVersions)
    .values({
      id,
      profileId: resolveProfileId(handle, input.profileId),
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
  profileId?: string,
): ProfileVersionRow | null {
  const row = handle.db
    .select()
    .from(candidateProfileVersions)
    .where(
      and(
        eq(candidateProfileVersions.profileId, resolveProfileId(handle, profileId)),
        eq(candidateProfileVersions.version, version),
      ),
    )
    .get();
  return row ?? null;
}

export function listProfileVersions(
  handle: DatabaseHandle,
  profileId?: string,
): ProfileVersionRow[] {
  return handle.db
    .select()
    .from(candidateProfileVersions)
    .where(eq(candidateProfileVersions.profileId, resolveProfileId(handle, profileId)))
    .orderBy(asc(candidateProfileVersions.version))
    .all();
}

export function getActiveProfileVersion(
  handle: DatabaseHandle,
  profileId?: string,
): ProfileVersionRow | null {
  const row = handle.db
    .select()
    .from(candidateProfileVersions)
    .where(
      and(
        eq(candidateProfileVersions.profileId, resolveProfileId(handle, profileId)),
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
        eq(candidateProfileVersions.profileId, target.profileId),
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
    provenanceJson?: string | null;
  },
): void {
  handle.db
    .insert(candidateFacts)
    .values({ provenanceJson: null, ...input })
    .run();
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

/**
 * Profile source documents (R-ADR-016). One row per profile version, set
 * at import/copy/backfill time; rows are insert-only by trigger.
 */
export function insertSource(
  handle: DatabaseHandle,
  input: {
    profileId: string;
    profileVersionId: string;
    relativePath: string;
    mediaType: string;
    byteSize: number;
    sha256: string;
    origin: string;
    originDetailJson?: string | null;
  },
): SourceRow {
  const id = newId();
  handle.db
    .insert(candidateSources)
    .values({ id, originDetailJson: null, ...input })
    .run();
  const row = handle.db
    .select()
    .from(candidateSources)
    .where(eq(candidateSources.id, id))
    .get();
  if (row === undefined) {
    throw new Error("inserted source is not readable");
  }
  return row as SourceRow;
}

/** The source row for one profile version, or null when never recorded. */
export function getSourceByVersion(
  handle: DatabaseHandle,
  profileVersionId: string,
): SourceRow | null {
  const row = handle.db
    .select()
    .from(candidateSources)
    .where(eq(candidateSources.profileVersionId, profileVersionId))
    .get();
  return (row ?? null) as SourceRow | null;
}

/** The source row recorded at one relative path, if any. */
export function getSourceByRelativePath(
  handle: DatabaseHandle,
  relativePath: string,
): SourceRow | null {
  const row = handle.db
    .select()
    .from(candidateSources)
    .where(eq(candidateSources.relativePath, relativePath))
    .get();
  return (row ?? null) as SourceRow | null;
}

/** Every recorded source of one profile, oldest first. */
export function listSourcesByProfile(handle: DatabaseHandle, profileId: string): SourceRow[] {
  return handle.db
    .select()
    .from(candidateSources)
    .where(eq(candidateSources.profileId, profileId))
    .orderBy(asc(candidateSources.createdAt), asc(candidateSources.id))
    .all() as SourceRow[];
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
