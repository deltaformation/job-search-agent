import { z } from "zod";
import {
  CANDIDATE_PROFILE_SCHEMA_VERSION,
  CANDIDATE_SNAPSHOT_SCHEMA_VERSION,
  CandidateImportV1,
  CandidateProfilePayloadV1,
  CandidateSnapshotV1,
  FactEvidenceV1,
  ProfileId,
  type SnapshotFactV1,
} from "../domain/candidate";
import { canonicalJson, canonicalText } from "../domain/canonical";
import type { ReasonCode } from "../domain/enums";
import { EntityId, IsoUtcDateTime } from "../domain/fields";
import type { DatabaseHandle } from "../db/client";
import {
  activateProfileVersion as activateVersionRow,
  ensureLocalProfile,
  getActiveProfileVersion,
  getCandidateSnapshotByHash,
  getExtractionJobId,
  getFact,
  getJdSnapshotByHash,
  getJobDescriptionPointer,
  getProfile,
  getProfileVersion,
  getProfileVersionByNumber,
  insertCandidateSnapshot,
  insertFact,
  insertJdSnapshot,
  insertProfileVersion,
  insertSnapshotFactMembership,
  listFactsByVersion,
  nextProfileVersionNumber,
} from "../db/candidates";
import { withTransaction } from "../db/transactions";
import { sha256HexUtf8, utcNow } from "../db/utils";

/**
 * Candidate import, activation, and snapshot service.
 *
 * A human authors a reviewed `candidate-import/v1` JSON file; `importCandidate`
 * validates it, stores an immutable profile version, and inserts its
 * achievement facts. `activateProfileVersion` selects the one active version.
 * Snapshot builders bind exact generation inputs: candidate snapshots embed
 * the full version payload plus approved facts, JD snapshots bind canonical
 * description text to its extraction. Schema violations throw `ZodError`;
 * rule rejections return `ok: false` with stable error codes.
 */

const HumanActor = z.literal("human");

export const ImportCandidateInput = z
  .object({
    document: z.unknown(),
    actor: HumanActor,
    now: IsoUtcDateTime.optional(),
    profileId: ProfileId.optional(),
  })
  .strict();
export type ImportCandidateInput = z.infer<typeof ImportCandidateInput>;

export type ImportCandidateResult =
  | {
      ok: true;
      versionId: string;
      version: number;
      insertedFacts: string[];
      reusedFacts: string[];
    }
  | { ok: false; error: "fact-id-conflict"; factId: string; detail: string }
  | { ok: false; error: "version-conflict"; detail: string }
  | { ok: false; error: "profile-not-found"; detail: string };

export const ActivateProfileVersionInput = z
  .object({
    versionId: EntityId.optional(),
    version: z.int().min(1).optional(),
    actor: HumanActor,
    now: IsoUtcDateTime.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.versionId === undefined && input.version === undefined) {
      ctx.addIssue({ code: "custom", message: "versionId or version is required" });
    }
  });
export type ActivateProfileVersionInput = z.infer<typeof ActivateProfileVersionInput>;

export type ActivateProfileVersionResult =
  | { ok: true; versionId: string; version: number; alreadyActive: boolean }
  | { ok: false; error: "version-not-found" };

export const CandidateSnapshotInput = z
  .object({ profileVersionId: EntityId })
  .strict();
export type CandidateSnapshotInput = z.infer<typeof CandidateSnapshotInput>;

export type CandidateSnapshotResult =
  | { ok: true; snapshotId: string; sha256: string; created: boolean }
  | { ok: false; error: "version-not-found" }
  | { ok: false; error: "snapshot-corrupt"; detail: string };

export const JdSnapshotInput = z
  .object({
    jobId: EntityId,
    extractionId: EntityId,
    jdText: z.string().min(1).max(500_000),
  })
  .strict();
export type JdSnapshotInput = z.infer<typeof JdSnapshotInput>;

export type JdSnapshotResult =
  | { ok: true; snapshotId: string; sha256: string; created: boolean }
  | { ok: false; error: "job-not-found" }
  | { ok: false; error: "extraction-not-found" }
  | { ok: false; error: "extraction-job-mismatch" }
  | { ok: false; error: "empty-jd"; detail: string };

export type ResolveSnapshotsResult =
  | {
      ok: true;
      jdSnapshotId: string;
      jdCreated: boolean;
      candidateSnapshotId: string;
      candidateCreated: boolean;
    }
  | { ok: false; error: "job-not-found" }
  | { ok: false; error: "blocked"; reason: ReasonCode; detail: string };

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    error instanceof Error &&
    new RegExp(`UNIQUE constraint failed: ${constraint}`).test(error.message)
  );
}

/** Private: a concurrent import inserted a fact_id after our pre-check. */
class FactRaceError extends Error {
  readonly factId: string;
  constructor(factId: string) {
    super(`concurrent import inserted fact_id '${factId}'`);
    this.name = "FactRaceError";
    this.factId = factId;
  }
}

/**
 * Import a reviewed master-resume document as a new immutable profile
 * version. Fact rows reuse only byte-identical `fact_id` content; any
 * conflicting reuse fails instead of mutating or fabricating.
 */
export function importCandidate(
  handle: DatabaseHandle,
  rawInput: ImportCandidateInput,
): ImportCandidateResult {
  const input = ImportCandidateInput.parse(rawInput);
  const document = CandidateImportV1.parse(input.document);
  void input.actor;
  void input.now;

  const payload = CandidateProfilePayloadV1.parse({
    ...document,
    schemaVersion: CANDIDATE_PROFILE_SCHEMA_VERSION,
  });
  const payloadJson = canonicalJson(payload);
  const payloadHash = sha256HexUtf8(payloadJson);
  if (input.profileId !== undefined && getProfile(handle, input.profileId) === null) {
    return { ok: false, error: "profile-not-found", detail: `unknown profile '${input.profileId}'` };
  }

  try {
    return withTransaction(handle.sqlite, () => {
      return importCandidateInto(handle, payload, payloadJson, payloadHash, input.profileId);
    });
  } catch (error: unknown) {
    if (error instanceof FactRaceError) {
      return {
        ok: false,
        error: "fact-id-conflict",
        factId: error.factId,
        detail: "a concurrent import inserted this fact_id; re-run the import",
      } as const;
    }
    throw error;
  }
}

/** Transaction body for `importCandidate`; see it for the write protocol. */
function importCandidateInto(
  handle: DatabaseHandle,
  payload: z.infer<typeof CandidateProfilePayloadV1>,
  payloadJson: string,
  payloadHash: string,
  profileId: string | undefined,
): ImportCandidateResult {
  return withTransaction(handle.sqlite, () => {
    if (profileId === undefined) {
      ensureLocalProfile(handle);
    }
    // Pre-check every achievement before inserting anything: a conflict must
    // reject with zero writes, not commit a version missing its facts.
    const prepared = payload.achievements.map((achievement) => {
      const evidence = FactEvidenceV1.parse({
        schemaVersion: "fact-evidence/v1",
        employmentId: achievement.employmentId,
        category: achievement.category,
        technologies: achievement.technologies,
        metrics: achievement.metrics,
      });
      return { achievement, evidenceJson: canonicalJson(evidence) };
    });
    for (const { achievement, evidenceJson } of prepared) {
      const existing = getFact(handle, achievement.factId);
      if (existing === null) {
        continue;
      }
      const identical =
        existing.kind === achievement.category &&
        existing.statement === achievement.text &&
        (existing.evidenceJson ?? null) === evidenceJson &&
        (existing.source ?? null) === (achievement.source ?? null);
      if (!identical) {
        return {
          ok: false,
          error: "fact-id-conflict",
          factId: achievement.factId,
          detail:
            "fact_id is already used with different content; mint a new fact_id for the revised fact",
        } as const;
      }
    }

    const version = nextProfileVersionNumber(handle, profileId);
    let versionRow;
    try {
      versionRow = insertProfileVersion(handle, {
        version,
        payloadJson,
        payloadHash,
        schemaVersion: CANDIDATE_PROFILE_SCHEMA_VERSION,
        profileId,
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error, "candidate_profile_versions")) {
        return { ok: false, error: "version-conflict", detail: "re-run the import" } as const;
      }
      throw error;
    }

    const insertedFacts: string[] = [];
    const reusedFacts: string[] = [];
    for (const { achievement, evidenceJson } of prepared) {
      if (getFact(handle, achievement.factId) !== null) {
        reusedFacts.push(achievement.factId);
        continue;
      }
      try {
        insertFact(handle, {
          factId: achievement.factId,
          profileVersionId: versionRow.id,
          kind: achievement.category,
          statement: achievement.text,
          evidenceJson,
          verification: achievement.verification,
          source: achievement.source ?? null,
        });
      } catch (error: unknown) {
        // A concurrent import won the race after our pre-check; roll the
        // whole import back and report it as a conflict, never a partial.
        if (isUniqueViolation(error, "candidate_facts")) {
          throw new FactRaceError(achievement.factId);
        }
        throw error;
      }
      insertedFacts.push(achievement.factId);
    }
    return { ok: true, versionId: versionRow.id, version, insertedFacts, reusedFacts } as const;
  });
}

/** Human selects the one active profile version (idempotent). */
export function activateProfileVersion(
  handle: DatabaseHandle,
  rawInput: ActivateProfileVersionInput,
): ActivateProfileVersionResult {
  const input = ActivateProfileVersionInput.parse(rawInput);
  void input.actor;
  const now = input.now ?? utcNow();
  return withTransaction(handle.sqlite, () => {
    const target =
      input.versionId !== undefined
        ? getProfileVersion(handle, input.versionId)
        : input.version !== undefined
          ? getProfileVersionByNumber(handle, input.version)
          : null;
    if (target === null) {
      return { ok: false, error: "version-not-found" } as const;
    }
    const active = getActiveProfileVersion(handle);
    if (active !== null && active.id === target.id) {
      return {
        ok: true,
        versionId: target.id,
        version: target.version,
        alreadyActive: true,
      } as const;
    }
    activateVersionRow(handle, target.id, now);
    return {
      ok: true,
      versionId: target.id,
      version: target.version,
      alreadyActive: false,
    } as const;
  });
}

export interface ActiveProfile {
  versionId: string;
  version: number;
  payloadHash: string;
  factIds: string[];
}

/** Active version plus its owned fact ids, or null when no profile is active. */
export function getActiveProfile(handle: DatabaseHandle): ActiveProfile | null {
  const active = getActiveProfileVersion(handle);
  if (active === null) {
    return null;
  }
  const facts = listFactsByVersion(handle, active.id);
  return {
    versionId: active.id,
    version: active.version,
    payloadHash: active.payloadHash,
    factIds: facts.map((fact) => fact.factId),
  };
}

/**
 * Get-or-create the immutable candidate snapshot for a profile version.
 * The canonical JSON embeds the full version payload plus every approved
 * fact the payload names (ordered by `fact_id`); membership rows mirror the
 * same set so resume claims can cite only bound evidence.
 */
export function getOrCreateCandidateSnapshot(
  handle: DatabaseHandle,
  rawInput: CandidateSnapshotInput,
): CandidateSnapshotResult {
  const input = CandidateSnapshotInput.parse(rawInput);
  return withTransaction(handle.sqlite, () => {
    const versionRow = getProfileVersion(handle, input.profileVersionId);
    if (versionRow === null) {
      return { ok: false, error: "version-not-found" } as const;
    }
    let payload: z.infer<typeof CandidateProfilePayloadV1>;
    try {
      payload = CandidateProfilePayloadV1.parse(JSON.parse(versionRow.payloadJson) as unknown);
    } catch {
      return {
        ok: false,
        error: "snapshot-corrupt",
        detail: "stored profile payload fails its schema; create a new version",
      } as const;
    }
    if (sha256HexUtf8(canonicalJson(payload)) !== versionRow.payloadHash) {
      return {
        ok: false,
        error: "snapshot-corrupt",
        detail: "stored profile payload does not match its recorded hash",
      } as const;
    }

    const facts: SnapshotFactV1[] = [];
    for (const achievement of payload.achievements) {
      const row = getFact(handle, achievement.factId);
      if (row === null) {
        return {
          ok: false,
          error: "snapshot-corrupt",
          detail: `payload names fact_id '${achievement.factId}' with no fact row`,
        } as const;
      }
      if (row.verification !== "APPROVED") {
        continue;
      }
      let evidence: SnapshotFactV1["evidence"] = null;
      if (row.evidenceJson !== null) {
        try {
          evidence = FactEvidenceV1.parse(JSON.parse(row.evidenceJson) as unknown);
        } catch {
          return {
            ok: false,
            error: "snapshot-corrupt",
            detail: `fact_id '${row.factId}' carries invalid evidence JSON`,
          } as const;
        }
      }
      facts.push({
        factId: row.factId,
        kind: row.kind,
        statement: row.statement,
        evidence,
        source: row.source,
        verification: "APPROVED",
      });
    }
    facts.sort((left, right) => (left.factId < right.factId ? -1 : left.factId > right.factId ? 1 : 0));

    const snapshot = CandidateSnapshotV1.parse({
      schemaVersion: CANDIDATE_SNAPSHOT_SCHEMA_VERSION,
      profileVersionId: versionRow.id,
      version: versionRow.version,
      payloadHash: versionRow.payloadHash,
      payload,
      facts,
    });
    const canonical = canonicalJson(snapshot);
    const sha256 = sha256HexUtf8(canonical);
    const existing = getCandidateSnapshotByHash(handle, versionRow.id, sha256);
    if (existing !== null) {
      return { ok: true, snapshotId: existing.id, sha256, created: false } as const;
    }
    try {
      const created = insertCandidateSnapshot(handle, {
        profileVersionId: versionRow.id,
        canonicalJson: canonical,
        schemaVersion: CANDIDATE_SNAPSHOT_SCHEMA_VERSION,
        sha256,
      });
      for (const fact of facts) {
        insertSnapshotFactMembership(handle, created.id, fact.factId);
      }
      return { ok: true, snapshotId: created.id, sha256, created: true } as const;
    } catch (error: unknown) {
      if (isUniqueViolation(error, "candidate_snapshots")) {
        const raced = getCandidateSnapshotByHash(handle, versionRow.id, sha256);
        if (raced !== null) {
          return { ok: true, snapshotId: raced.id, sha256, created: false } as const;
        }
      }
      throw error;
    }
  });
}

/**
 * Get-or-create the immutable JD snapshot for a job's extraction text.
 * Canonical NFC/LF text is hashed; the raw extraction row stays the
 * recoverable source behind `extraction_id` lineage.
 */
export function getOrCreateJdSnapshot(
  handle: DatabaseHandle,
  rawInput: JdSnapshotInput,
): JdSnapshotResult {
  const input = JdSnapshotInput.parse(rawInput);
  const jdText = canonicalText(input.jdText);
  if (jdText === "") {
    return {
      ok: false,
      error: "empty-jd",
      detail: "job description is empty after canonicalization",
    } as const;
  }
  const sha256 = sha256HexUtf8(jdText);
  return withTransaction(handle.sqlite, () => {
    const pointer = getJobDescriptionPointer(handle, input.jobId);
    if (pointer === null) {
      return { ok: false, error: "job-not-found" } as const;
    }
    const extractionJobId = getExtractionJobId(handle, input.extractionId);
    if (extractionJobId === null) {
      return { ok: false, error: "extraction-not-found" } as const;
    }
    if (extractionJobId !== input.jobId) {
      return { ok: false, error: "extraction-job-mismatch" } as const;
    }
    const existing = getJdSnapshotByHash(handle, input.jobId, sha256);
    if (existing !== null) {
      return { ok: true, snapshotId: existing.id, sha256, created: false } as const;
    }
    try {
      const created = insertJdSnapshot(handle, {
        jobId: input.jobId,
        extractionId: input.extractionId,
        jdText,
        canonicalSha256: sha256,
      });
      return { ok: true, snapshotId: created.id, sha256, created: true } as const;
    } catch (error: unknown) {
      if (isUniqueViolation(error, "jd_snapshots")) {
        const raced = getJdSnapshotByHash(handle, input.jobId, sha256);
        if (raced !== null) {
          return { ok: true, snapshotId: raced.id, sha256, created: false } as const;
        }
      }
      throw error;
    }
  });
}

/**
 * Resolve the current generation inputs for a job, creating snapshots when
 * missing: the candidate snapshot of the active profile version and the JD
 * snapshot of the active extraction text. Missing profile or description
 * fails with the reason code the tailoring worker reports as BLOCKED.
 * An explicit `profileId` binds that profile's active version (a profile
 * deleted after enqueue blocks as stale input).
 */
export function resolveCurrentSnapshots(
  handle: DatabaseHandle,
  jobId: string,
  options: { profileId?: string } = {},
): ResolveSnapshotsResult {
  const parsedJobId = EntityId.parse(jobId);
  const pointer = getJobDescriptionPointer(handle, parsedJobId);
  if (pointer === null) {
    return { ok: false, error: "job-not-found" };
  }
  const selected =
    options.profileId === undefined ? null : getProfile(handle, options.profileId);
  if (options.profileId !== undefined && selected === null) {
    return {
      ok: false,
      error: "blocked",
      reason: "STALE_INPUT",
      detail: `selected career profile '${options.profileId}' no longer exists`,
    };
  }
  const active = getActiveProfileVersion(handle, options.profileId);
  if (active === null) {
    return {
      ok: false,
      error: "blocked",
      reason: "PROFILE_REQUIRED",
      detail:
        selected === null
          ? "no active candidate profile version; import and activate one first"
          : `career profile '${selected.displayName}' has no active version; import and activate one first`,
    };
  }
  if (pointer.descriptionText === null || pointer.activeExtractionId === null) {
    return {
      ok: false,
      error: "blocked",
      reason: "EXTRACTION_INCOMPLETE",
      detail: "job has no active extraction text to snapshot",
    };
  }
  const candidate = getOrCreateCandidateSnapshot(handle, { profileVersionId: active.id });
  if (!candidate.ok) {
    return {
      ok: false,
      error: "blocked",
      reason: "STALE_INPUT",
      detail: `active profile version cannot snapshot: ${candidate.error}`,
    };
  }
  const jd = getOrCreateJdSnapshot(handle, {
    jobId: parsedJobId,
    extractionId: pointer.activeExtractionId,
    jdText: pointer.descriptionText,
  });
  if (!jd.ok) {
    if (jd.error === "empty-jd") {
      return { ok: false, error: "blocked", reason: "EXTRACTION_INCOMPLETE", detail: jd.detail };
    }
    return {
      ok: false,
      error: "blocked",
      reason: "STALE_INPUT",
      detail: `job description cannot snapshot: ${jd.error}`,
    };
  }
  return {
    ok: true,
    jdSnapshotId: jd.snapshotId,
    jdCreated: jd.created,
    candidateSnapshotId: candidate.snapshotId,
    candidateCreated: candidate.created,
  };
}
