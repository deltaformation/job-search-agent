import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CANDIDATE_IMPORT_SCHEMA_VERSION_V2,
  CANDIDATE_PROFILE_SCHEMA_VERSION_V2,
  CANDIDATE_SNAPSHOT_SCHEMA_VERSION,
  CandidateProfilePayloadV2,
  CandidateSnapshotV1,
  FACT_PROVENANCE_SCHEMA_VERSION,
  FactEvidenceV1,
  normalizeImportDocument,
  parseStoredProfilePayload,
  ProfileDisplayName,
  ProfileId,
  ProfileSlug,
  type SnapshotFactV1,
} from "../domain/candidate";
import { canonicalJson, canonicalText } from "../domain/canonical";
import type { ReasonCode } from "../domain/enums";
import { EntityId, IsoUtcDateTime } from "../domain/fields";
import type { DatabaseHandle } from "../db/client";
import {
  activateProfileVersion as activateVersionRow,
  createProfile,
  ensureLocalProfile,
  getActiveProfileVersion,
  getDefaultProfile,
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
  insertSource,
  listFactsByVersion,
  nextProfileVersionNumber,
} from "../db/candidates";
import {
  publishSourceBytes,
  SOURCE_MEDIA_TYPE,
  SOURCE_ORIGIN_DETAIL_VERSION,
} from "./sources";
import { withTransaction } from "../db/transactions";
import { newId, sha256HexUtf8, utcNow } from "../db/utils";

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
    /** Pre-minted version id for publish-before-commit flows; minted when absent. */
    versionId: EntityId.optional(),
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
      /** Declared ids remapped to minted cross-profile copies. */
      remappedFacts: Array<{ from: string; to: string }>;
    }
  | { ok: false; error: "fact-id-conflict"; factId: string; detail: string }
  | { ok: false; error: "version-conflict"; detail: string }
  | { ok: false; error: "profile-not-found"; detail: string }
  | { ok: false; error: "unknown-edited-from"; factId: string; detail: string }
  | { ok: false; error: "edited-from-mismatch"; factId: string; detail: string };

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

export function isUniqueViolation(error: unknown, constraint: string): boolean {
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
  void input.actor;
  void input.now;

  const normalized = normalizeImportDocument(input.document);
  if (input.profileId !== undefined && getProfile(handle, input.profileId) === null) {
    return { ok: false, error: "profile-not-found", detail: `unknown profile '${input.profileId}'` };
  }

  try {
    return withTransaction(handle.sqlite, () => {
      return importCandidateInto(
        handle,
        normalized.payload,
        normalized.editedFrom,
        input.profileId,
        input.versionId,
      );
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

/** Canonical fingerprint judging two evidences identical for reuse. */
function evidenceFingerprint(input: {
  kind: string;
  statement: string;
  evidenceJson: string | null;
  source: string | null;
}): string {
  return sha256HexUtf8(
    canonicalJson({
      kind: input.kind,
      statement: input.statement,
      evidenceJson: input.evidenceJson,
      source: input.source,
    }),
  );
}

/** Mint a globally fresh fact id for a cross-profile copy. */
function mintFactId(handle: DatabaseHandle): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = `fact-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    if (getFact(handle, candidate) === null) {
      return candidate;
    }
  }
  throw new Error("could not mint a fresh fact_id");
}

/**
 * Transaction body for `importCandidate`. Resolves the target profile,
 * then pre-checks every achievement before inserting anything: a
 * conflict rejects with zero writes, never a partial version.
 *
 * Reuse rules (R-ADR-020): same id plus identical content in the SAME
 * profile lineage reuses the row; the same situation across profiles
 * mints a new id with `import-remap` provenance (ordinary reuse never
 * fails, never silently shares); same id plus different content always
 * conflicts; `editedFrom` annotates new ids only.
 */
function importCandidateInto(
  handle: DatabaseHandle,
  payload: z.infer<typeof CandidateProfilePayloadV2>,
  editedFrom: Map<string, string>,
  profileId: string | undefined,
  versionId: string | undefined,
): ImportCandidateResult {
  return withTransaction(handle.sqlite, () => {
    // Explicit values may be ids or names; resolve to the row id so
    // version rows never carry a name in the profile_id column.
    const explicitId =
      profileId === undefined ? undefined : (getProfile(handle, profileId)?.id ?? null);
    if (explicitId === null) {
      return {
        ok: false,
        error: "profile-not-found",
        detail: `unknown profile '${profileId}'`,
      } as const;
    }
    const targetProfileId = explicitId ?? getDefaultProfile(handle)?.id ?? ensureLocalProfile(handle);
    const prepared = payload.achievements.map((achievement) => {
      const evidence = FactEvidenceV1.parse({
        schemaVersion: "fact-evidence/v1",
        // Omit — never pass explicit undefined: zod preserves the key
        // and canonicalJson rightly rejects undefined values.
        ...(achievement.employmentId === undefined ? {} : { employmentId: achievement.employmentId }),
        category: achievement.category,
        technologies: achievement.technologies,
        metrics: achievement.metrics,
      });
      return { achievement, evidenceJson: canonicalJson(evidence) };
    });
    const remappedFacts: Array<{ from: string; to: string }> = [];
    const finalIds = new Map<string, string>();
    const provenances = new Map<string, string>();
    for (const { achievement, evidenceJson } of prepared) {
      const declaredId = achievement.factId;
      const existing = getFact(handle, declaredId);
      const editOrigin = editedFrom.get(declaredId);
      if (editOrigin !== undefined && existing !== null) {
        return {
          ok: false,
          error: "edited-from-mismatch",
          factId: declaredId,
          detail: `editedFrom requires a new fact_id; '${declaredId}' already exists`,
        } as const;
      }
      if (editOrigin !== undefined && getFact(handle, editOrigin) === null) {
        return {
          ok: false,
          error: "unknown-edited-from",
          factId: declaredId,
          detail: `editedFrom references unknown fact_id '${editOrigin}'`,
        } as const;
      }
      if (existing === null) {
        finalIds.set(declaredId, declaredId);
        if (editOrigin !== undefined) {
          const origin = getFact(handle, editOrigin);
          provenances.set(
            declaredId,
            canonicalJson({
              schemaVersion: FACT_PROVENANCE_SCHEMA_VERSION,
              origin: "edit",
              originFactId: editOrigin,
              evidenceHash: evidenceFingerprint({
                kind: achievement.category,
                statement: achievement.text,
                evidenceJson,
                source: achievement.source ?? null,
              }),
              ...(origin === null ? {} : { originVersionId: origin.profileVersionId }),
            }),
          );
        }
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
          factId: declaredId,
          detail:
            "fact_id is already used with different content; mint a new fact_id for the revised fact",
        } as const;
      }
      const ownerVersion = getProfileVersion(handle, existing.profileVersionId);
      if (ownerVersion !== null && ownerVersion.profileId === targetProfileId) {
        finalIds.set(declaredId, declaredId);
        continue;
      }
      // Identical evidence owned by another profile (or an orphaned row):
      // mint an explicit copy instead of silently sharing the row.
      const minted = mintFactId(handle);
      finalIds.set(declaredId, minted);
      remappedFacts.push({ from: declaredId, to: minted });
      provenances.set(
        minted,
        canonicalJson({
          schemaVersion: FACT_PROVENANCE_SCHEMA_VERSION,
          origin: "import-remap",
          ...(ownerVersion === null ? {} : { originVersionId: ownerVersion.id }),
          originFactId: declaredId,
          evidenceHash: evidenceFingerprint({
            kind: achievement.category,
            statement: achievement.text,
            evidenceJson,
            source: achievement.source ?? null,
          }),
        }),
      );
    }

    const finalPayload = CandidateProfilePayloadV2.parse({
      ...payload,
      achievements: payload.achievements.map((achievement) => ({
        ...achievement,
        factId: finalIds.get(achievement.factId) ?? achievement.factId,
      })),
    });
    const payloadJson = canonicalJson(finalPayload);
    const payloadHash = sha256HexUtf8(payloadJson);

    const version = nextProfileVersionNumber(handle, targetProfileId);
    let versionRow;
    try {
      versionRow = insertProfileVersion(handle, {
        id: versionId,
        version,
        payloadJson,
        payloadHash,
        schemaVersion: CANDIDATE_PROFILE_SCHEMA_VERSION_V2,
        profileId: targetProfileId,
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
      const finalId = finalIds.get(achievement.factId) ?? achievement.factId;
      if (getFact(handle, finalId) !== null) {
        reusedFacts.push(achievement.factId);
        continue;
      }
      try {
        insertFact(handle, {
          factId: finalId,
          profileVersionId: versionRow.id,
          kind: achievement.category,
          statement: achievement.text,
          evidenceJson,
          verification: achievement.verification,
          source: achievement.source ?? null,
          provenanceJson: provenances.get(finalId) ?? null,
        });
      } catch (error: unknown) {
        // A concurrent import won the race after our pre-check; roll the
        // whole import back and report it as a conflict, never a partial.
        if (isUniqueViolation(error, "candidate_facts")) {
          throw new FactRaceError(finalId);
        }
        throw error;
      }
      insertedFacts.push(finalId);
    }
    return { ok: true, versionId: versionRow.id, version, insertedFacts, reusedFacts, remappedFacts } as const;
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

export const CopyProfileInput = z
  .object({
    sourceProfileId: ProfileId,
    sourceVersionId: EntityId.optional(),
    name: ProfileSlug,
    displayName: ProfileDisplayName,
    actor: HumanActor,
    now: IsoUtcDateTime.optional(),
  })
  .strict();
export type CopyProfileInput = z.infer<typeof CopyProfileInput>;

export type CopyProfileResult =
  | {
      ok: true;
      profileId: string;
      versionId: string;
      version: number;
      copiedFacts: number;
      factIdMap: Array<{ from: string; to: string }>;
    }
  | { ok: false; error: "profile-not-found"; detail: string }
  | { ok: false; error: "version-not-found"; detail: string }
  | { ok: false; error: "version-profile-mismatch"; detail: string }
  | { ok: false; error: "name-taken"; detail: string }
  | { ok: false; error: "source-has-no-active-version"; detail: string }
  | { ok: false; error: "source-corrupt"; detail: string }
  | { ok: false; error: "version-conflict"; detail: string };

/**
 * Create a new profile from a selected immutable source version (B6,
 * R-ADR-020): every fact is copied to a minted id with `copy`
 * provenance, verification states are retained exactly as stored
 * (never upgraded), preferences/narrative are copied by value, and the
 * result is an inactive draft requiring explicit activation. Source
 * bytes publish before the single short transaction commits; generated
 * resumes, approvals, and applications are never touched.
 */
export function copyProfileFromVersion(
  handle: DatabaseHandle,
  rawInput: CopyProfileInput,
  deps: { sourcesDir: string },
): CopyProfileResult {
  const input = CopyProfileInput.parse(rawInput);
  void input.actor;
  void input.now;

  const sourceProfile = getProfile(handle, input.sourceProfileId);
  if (sourceProfile === null) {
    return { ok: false, error: "profile-not-found", detail: `unknown profile '${input.sourceProfileId}'` };
  }
  const sourceVersion =
    input.sourceVersionId !== undefined
      ? getProfileVersion(handle, input.sourceVersionId)
      : getActiveProfileVersion(handle, sourceProfile.id);
  if (input.sourceVersionId !== undefined && sourceVersion === null) {
    return { ok: false, error: "version-not-found", detail: `unknown version '${input.sourceVersionId}'` };
  }
  if (sourceVersion === null) {
    return {
      ok: false,
      error: "source-has-no-active-version",
      detail: `profile '${sourceProfile.name}' has no active version to copy`,
    };
  }
  if (sourceVersion.profileId !== sourceProfile.id) {
    return {
      ok: false,
      error: "version-profile-mismatch",
      detail: `version '${sourceVersion.id}' does not belong to profile '${sourceProfile.name}'`,
    };
  }
  if (getProfile(handle, input.name) !== null) {
    return { ok: false, error: "name-taken", detail: `profile name '${input.name}' is taken` };
  }
  let sourcePayload: ReturnType<typeof parseStoredProfilePayload>;
  try {
    sourcePayload = parseStoredProfilePayload(JSON.parse(sourceVersion.payloadJson) as unknown);
  } catch {
    return {
      ok: false,
      error: "source-corrupt",
      detail: "source payload fails its schema; copy is refused",
    };
  }

  // Pre-mint every id and validate every source row before writing:
  // a corrupt source fails with zero writes and zero published bytes.
  const profileId = newId();
  const versionId = newId();
  const factIdMap: Array<{ from: string; to: string }> = [];
  const copied: Array<{
    achievement: (typeof sourcePayload.achievements)[number];
    evidenceJson: string;
    verification: string;
    minted: string;
  }> = [];
  for (const achievement of sourcePayload.achievements) {
    const row = getFact(handle, achievement.factId);
    if (row === null) {
      return {
        ok: false,
        error: "source-corrupt",
        detail: `source payload names fact '${achievement.factId}' with no stored row; refusing to manufacture it`,
      };
    }
    const evidence = FactEvidenceV1.parse({
      schemaVersion: "fact-evidence/v1",
      // Omit — never pass explicit undefined: zod preserves the key
      // and canonicalJson rightly rejects undefined values.
      ...(achievement.employmentId === undefined ? {} : { employmentId: achievement.employmentId }),
      category: achievement.category,
      technologies: achievement.technologies,
      metrics: achievement.metrics,
    });
    const evidenceJson = canonicalJson(evidence);
    if (
      row.kind !== achievement.category ||
      row.statement !== achievement.text ||
      (row.evidenceJson ?? null) !== evidenceJson ||
      (row.source ?? null) !== (achievement.source ?? null)
    ) {
      return {
        ok: false,
        error: "source-corrupt",
        detail: `stored row for fact '${achievement.factId}' diverges from the source payload; refusing to copy`,
      };
    }
    const minted = mintFactId(handle);
    factIdMap.push({ from: achievement.factId, to: minted });
    copied.push({ achievement, evidenceJson, verification: row.verification, minted });
  }

  const newPayload = CandidateProfilePayloadV2.parse({
    ...sourcePayload,
    schemaVersion: CANDIDATE_PROFILE_SCHEMA_VERSION_V2,
    achievements: sourcePayload.achievements.map((achievement, index) => ({
      ...achievement,
      factId: copied[index]?.minted ?? achievement.factId,
    })),
  });
  const payloadJson = canonicalJson(newPayload);
  const payloadHash = sha256HexUtf8(payloadJson);
  const sourceBytes = Buffer.from(
    `${JSON.stringify({ ...newPayload, schemaVersion: CANDIDATE_IMPORT_SCHEMA_VERSION_V2 }, null, 2)}\n`,
    "utf8",
  );
  const published = publishSourceBytes(deps.sourcesDir, profileId, versionId, sourceBytes);

  const copiedPreferences =
    sourceProfile.workPreferences === null
      ? undefined
      : (({ schemaVersion: _stamped, ...rest }) => rest)(sourceProfile.workPreferences);
  try {
    return withTransaction(handle.sqlite, () => {
      createProfile(
        handle,
        {
          name: input.name,
          displayName: input.displayName,
          isDefault: false,
          ...(copiedPreferences === undefined ? {} : { workPreferences: copiedPreferences }),
          ...(sourceProfile.executiveNarrative === null
            ? {}
            : { executiveNarrative: sourceProfile.executiveNarrative }),
        },
        { id: profileId },
      );
      insertProfileVersion(handle, {
        id: versionId,
        version: 1,
        payloadJson,
        payloadHash,
        schemaVersion: CANDIDATE_PROFILE_SCHEMA_VERSION_V2,
        profileId,
      });
      for (const entry of copied) {
        insertFact(handle, {
          factId: entry.minted,
          profileVersionId: versionId,
          kind: entry.achievement.category,
          statement: entry.achievement.text,
          evidenceJson: entry.evidenceJson,
          verification: entry.verification as "PENDING" | "APPROVED" | "REJECTED",
          source: entry.achievement.source ?? null,
          provenanceJson: canonicalJson({
            schemaVersion: FACT_PROVENANCE_SCHEMA_VERSION,
            origin: "copy",
            originProfileId: sourceProfile.id,
            originVersionId: sourceVersion.id,
            originFactId: entry.achievement.factId,
            evidenceHash: evidenceFingerprint({
              kind: entry.achievement.category,
              statement: entry.achievement.text,
              evidenceJson: entry.evidenceJson,
              source: entry.achievement.source ?? null,
            }),
          }),
        });
      }
      insertSource(handle, {
        profileId,
        profileVersionId: versionId,
        relativePath: published.relativePath,
        mediaType: SOURCE_MEDIA_TYPE,
        byteSize: published.byteSize,
        sha256: published.sha256,
        origin: "copy",
        originDetailJson: JSON.stringify({
          schemaVersion: SOURCE_ORIGIN_DETAIL_VERSION,
          kind: "copy",
          sourceProfileId: sourceProfile.id,
          sourceVersionId: sourceVersion.id,
        }),
      });
      return {
        ok: true,
        profileId,
        versionId,
        version: 1,
        copiedFacts: copied.length,
        factIdMap,
      } as const;
    });
  } catch (error: unknown) {
    // Published bytes without a row are adopted by the next backfill or
    // left for reconcile; the failed copy itself leaves no rows.
    if (isUniqueViolation(error, "candidate_profiles")) {
      return { ok: false, error: "name-taken", detail: `profile name '${input.name}' is taken` } as const;
    }
    if (isUniqueViolation(error, "candidate_profile_versions")) {
      return { ok: false, error: "version-conflict", detail: "re-run the copy" } as const;
    }
    throw error;
  }
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
    let payload: ReturnType<typeof parseStoredProfilePayload>;
    try {
      payload = parseStoredProfilePayload(JSON.parse(versionRow.payloadJson) as unknown);
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
