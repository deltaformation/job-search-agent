import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { z } from "zod";
import type { DatabaseHandle } from "../db/client";
import {
  getActiveProfileVersion,
  getProfileVersion,
  getSourceByRelativePath,
  getSourceByVersion,
  insertSource,
  listProfiles,
  type SourceRow,
} from "../db/candidates";
import {
  CANDIDATE_IMPORT_SCHEMA_VERSION_V2,
  parseStoredProfilePayload,
} from "../domain/candidate";
import { SourceOrigin } from "../domain/enums";
import { resolveArtifactPath } from "../security/paths";

/**
 * Profile-owned master source documents (R-ADR-016).
 *
 * Each profile version's validated master bytes live immutably at
 * `sources/{profileId}/{versionId}.json` with a `candidate_sources`
 * row carrying size, hash, and origin. Reads resolve through the
 * database row and the allowlisted root — never through caller-built
 * paths — and re-verify size/hash, so a swapped or symlinked file
 * fails closed instead of serving foreign bytes.
 *
 * Filesystem writes always happen outside SQLite transactions; the
 * row insert joins the caller's short transaction. A crash between
 * the two leaves bytes without a row, which the backfill adopts
 * deterministically (same bytes → same path) or the reconciler
 * quarantines (unrecognizable debris).
 */

export const SOURCE_MEDIA_TYPE = "application/json";
const LEGACY_EVIDENCE_PATH = "_legacy/master-resume.json";
const QUARANTINE_DIR_NAME = ".quarantine";

export const SOURCE_ORIGIN_DETAIL_VERSION = "source-origin-detail/v1";

export const SourceOriginDetailV1 = z
  .object({
    schemaVersion: z.literal(SOURCE_ORIGIN_DETAIL_VERSION),
    kind: z.enum(["copy", "reconstructed"]),
    sourceProfileId: z.string().trim().min(1).max(64).optional(),
    sourceVersionId: z.string().trim().min(1).max(64).optional(),
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    payloadSchemaVersion: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type SourceOriginDetailV1 = z.infer<typeof SourceOriginDetailV1>;

function assertSafeSegment(value: string, what: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) || value.length > 64) {
    throw new Error(`unsafe ${what} for source path: ${JSON.stringify(value)}`);
  }
}

/** Deterministic owned path for one version's master bytes. */
export function sourceRelativePath(profileId: string, profileVersionId: string): string {
  assertSafeSegment(profileId, "profile id");
  assertSafeSegment(profileVersionId, "profile version id");
  return `${profileId}/${profileVersionId}.json`;
}

export interface PublishedSource {
  relativePath: string;
  byteSize: number;
  sha256: string;
}

/**
 * Durably write one version's master bytes (tmp file + fsync + atomic
 * rename, mirroring the artifact protocol). Idempotent for identical
 * bytes; never overwrites differing bytes at an owned path.
 */
export function publishSourceBytes(
  sourcesDir: string,
  profileId: string,
  profileVersionId: string,
  bytes: Buffer,
): PublishedSource {
  const relativePath = sourceRelativePath(profileId, profileVersionId);
  const absolutePath = join(sourcesDir, profileId, `${profileVersionId}.json`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(dirname(absolutePath), { recursive: true });
  if (existsSync(absolutePath)) {
    const current = readFileSync(absolutePath);
    if (current.equals(bytes)) {
      return { relativePath, byteSize: bytes.length, sha256 };
    }
    throw new Error(`refusing to overwrite source bytes at ${relativePath}`);
  }
  const tempPath = `${absolutePath}.tmp-${process.pid}-${Math.floor(Math.random() * 1_000_000_000)}`;
  const fd = openSync(tempPath, "w");
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, absolutePath);
  return { relativePath, byteSize: bytes.length, sha256 };
}

export type ReadSourceError =
  | "version-not-found"
  | "version-profile-mismatch"
  | "source-missing"
  | "source-unreadable"
  | "source-corrupt";

export interface ReadSourceSuccess {
  ok: true;
  bytes: Buffer;
  row: SourceRow;
}

export interface ReadSourceFailure {
  ok: false;
  error: ReadSourceError;
  detail: string;
}

export type ReadSourceResult = ReadSourceSuccess | ReadSourceFailure;

/**
 * Read one version's master bytes after proving the version belongs to
 * the profile, then re-verify size/hash against the row. String ids
 * from callers only ever reach database lookups — never the path.
 */
export function readSourceBytes(
  handle: DatabaseHandle,
  sourcesDir: string,
  profileId: string,
  profileVersionId: string,
): ReadSourceResult {
  const version = getProfileVersion(handle, profileVersionId);
  if (version === null) {
    return { ok: false, error: "version-not-found", detail: `unknown version '${profileVersionId}'` };
  }
  if (version.profileId !== profileId) {
    return {
      ok: false,
      error: "version-profile-mismatch",
      detail: `version '${profileVersionId}' does not belong to profile '${profileId}'`,
    };
  }
  const row = getSourceByVersion(handle, profileVersionId);
  if (row === null) {
    return {
      ok: false,
      error: "source-missing",
      detail: `no recorded source for version '${profileVersionId}'`,
    };
  }
  if (row.profileId !== profileId) {
    return {
      ok: false,
      error: "version-profile-mismatch",
      detail: `source for version '${profileVersionId}' does not belong to profile '${profileId}'`,
    };
  }
  let resolved: string;
  try {
    resolved = resolveArtifactPath(sourcesDir, row.relativePath);
  } catch (error: unknown) {
    return {
      ok: false,
      error: "source-unreadable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolved);
  } catch (error: unknown) {
    return {
      ok: false,
      error: "source-unreadable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (bytes.length !== row.byteSize || createHash("sha256").update(bytes).digest("hex") !== row.sha256) {
    return {
      ok: false,
      error: "source-corrupt",
      detail: `source bytes for version '${profileVersionId}' do not match the recorded size/hash`,
    };
  }
  return { ok: true, bytes, row };
}

export interface ReconcileReport {
  quarantined: string[];
  missingFiles: Array<{ profileVersionId: string; relativePath: string }>;
}

/**
 * Startup recovery for the sources tree: quarantine `*.tmp-*` debris
 * and unreferenced final-path files (crashed publishes whose version
 * row never committed) under `.quarantine/{stamp}/`, preserving bytes
 * for inspection, and report rows whose file is missing (never
 * auto-fixed, never blessed). Runs after `backfillProfileSources`,
 * which adopts still-valid orphaned files for active versions first.
 */
export function reconcileSources(handle: DatabaseHandle, sourcesDir: string): ReconcileReport {
  const quarantined: string[] = [];
  const missingFiles: ReconcileReport["missingFiles"] = [];
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
  const quarantineRoot = join(sourcesDir, QUARANTINE_DIR_NAME, stamp);
  const sweep = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (dir === sourcesDir && (entry === QUARANTINE_DIR_NAME || entry === "_legacy")) {
        continue;
      }
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        sweep(full);
        continue;
      }
      const relative = full.slice(sourcesDir.length + 1);
      const isDebris = entry.includes(".tmp-");
      const isOrphanedFinal =
        !isDebris &&
        entry.endsWith(".json") &&
        getSourceByRelativePath(handle, relative.split(sep).join("/")) === null;
      if (!isDebris && !isOrphanedFinal) {
        continue;
      }
      const dest = join(quarantineRoot, relative);
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(full, dest);
      quarantined.push(relative);
    }
  };
  sweep(sourcesDir);
  for (const profile of listProfiles(handle)) {
    const active = getActiveProfileVersion(handle, profile.id);
    if (active === null) {
      continue;
    }
    const row = getSourceByVersion(handle, active.id);
    if (row === null) {
      continue;
    }
    let resolved: string;
    try {
      resolved = resolveArtifactPath(sourcesDir, row.relativePath);
    } catch {
      missingFiles.push({ profileVersionId: active.id, relativePath: row.relativePath });
      continue;
    }
    if (!existsSync(resolved)) {
      missingFiles.push({ profileVersionId: active.id, relativePath: row.relativePath });
    }
  }
  return { quarantined, missingFiles };
}

export interface BackfillReport {
  reconstructed: string[];
  skipped: Array<{ profileVersionId: string; reason: string }>;
  legacyPreserved: boolean;
}

function serializeImportDocument(payload: Record<string, unknown>): Buffer {
  return Buffer.from(
    `${JSON.stringify({ ...payload, schemaVersion: CANDIDATE_IMPORT_SCHEMA_VERSION_V2 }, null, 2)}\n`,
    "utf8",
  );
}

/**
 * One-time-per-version upgrade backfill (idempotent): for every
 * profile's active version lacking a source row, reconstruct the
 * import document from the stored payload — the payload is
 * authoritative — publish it, and record the row labeled
 * `reconstructed`. Unparseable payloads are skipped with a reason,
 * never fatal. The legacy global file, when present, is preserved
 * read-only as evidence; it is never assigned to any profile.
 */
export function backfillProfileSources(
  handle: DatabaseHandle,
  input: { sourcesDir: string; candidateDir: string },
): BackfillReport {
  const report: BackfillReport = { reconstructed: [], skipped: [], legacyPreserved: false };
  for (const profile of listProfiles(handle)) {
    const active = getActiveProfileVersion(handle, profile.id);
    if (active === null || getSourceByVersion(handle, active.id) !== null) {
      continue;
    }
    let payload: Record<string, unknown>;
    try {
      payload = parseStoredProfilePayload(JSON.parse(active.payloadJson) as unknown) as unknown as Record<
        string,
        unknown
      >;
    } catch {
      report.skipped.push({ profileVersionId: active.id, reason: "stored payload is not a valid profile document" });
      continue;
    }
    const bytes = serializeImportDocument(payload);
    const published = publishSourceBytes(input.sourcesDir, profile.id, active.id, bytes);
    const detail: SourceOriginDetailV1 = {
      schemaVersion: SOURCE_ORIGIN_DETAIL_VERSION,
      kind: "reconstructed",
      payloadHash: active.payloadHash,
      payloadSchemaVersion: active.schemaVersion,
    };
    insertSource(handle, {
      profileId: profile.id,
      profileVersionId: active.id,
      relativePath: published.relativePath,
      mediaType: SOURCE_MEDIA_TYPE,
      byteSize: published.byteSize,
      sha256: published.sha256,
      origin: SourceOrigin.parse("reconstructed"),
      originDetailJson: JSON.stringify(detail),
    });
    report.reconstructed.push(active.id);
  }
  const legacyPath = join(input.candidateDir, "master-resume.json");
  const evidencePath = join(input.sourcesDir, LEGACY_EVIDENCE_PATH);
  if (!existsSync(evidencePath)) {
    try {
      if (existsSync(legacyPath) && statSync(legacyPath).isFile()) {
        mkdirSync(dirname(evidencePath), { recursive: true });
        copyFileSync(legacyPath, evidencePath);
        report.legacyPreserved = true;
      }
    } catch {
      report.legacyPreserved = false;
    }
  }
  return report;
}
