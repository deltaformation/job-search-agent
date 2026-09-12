import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { DatabaseHandle } from "../db/client";
import { discoverMigrationFiles } from "../db/migrate";
import { IsoUtcDateTime } from "../domain/fields";
import type { DataRootPaths } from "../security/data-root";
import { createTarWriter, extractTarStrict, gunzipTar, gzipTar } from "./tar";

/**
 * Settings backup/restore service (R5-A). Backups checkpoint WAL, copy the
 * database through SQLite's online backup API (never a raw copy of the
 * live file), and archive database + evidence + artifacts + candidate
 * profile with a hash manifest into a gzipped ustar. Restore verifies the
 * staged set (manifest, member hashes, SQLite integrity, migration
 * ceiling) before replacing anything, keeps a pre-restore backup, swaps
 * crash-recoverably, and bumps a generation marker the worker watches to
 * reopen its database handle without a process restart.
 */

export const BACKUP_MANIFEST_VERSION = "backup-manifest/v1";
export const DATABASE_MEMBER = "sqlite/job-tracker.sqlite";
export const MANIFEST_MEMBER = "manifest.json";
export const GENERATION_FILENAME = ".restore-generation";
export const BACKUPS_DIR_NAME = "backups";

export const MAX_BACKUP_UNCOMPRESSED_BYTES = 1_073_741_824;
export const MAX_BACKUP_FILE_BYTES = 268_435_456;
export const MAX_BACKUP_FILES = 50_000;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

const ManifestMemberV1 = z
  .object({
    name: z.string().min(1).max(100),
    bytes: z.number().int().min(0),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const BackupManifestV1 = z
  .object({
    schemaVersion: z.literal(BACKUP_MANIFEST_VERSION),
    createdAt: IsoUtcDateTime,
    kind: z.enum(["manual", "pre-restore", "pre-reset"]),
    database: ManifestMemberV1,
    members: z.array(ManifestMemberV1).min(1),
    counts: z.object({ jobs: z.number().int().min(0) }).strict(),
  })
  .strict();
export type BackupManifestV1 = z.infer<typeof BackupManifestV1>;

export function backupFilenameFor(date: Date): string {
  const day = date.toISOString().slice(0, 10);
  return `job-tracker-backup-${day}.tar.gz`;
}

export function safetyBackupFilenameFor(kind: "pre-restore" | "pre-reset", date: Date): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
  return `${kind}-${stamp}.tar.gz`;
}

export function sha256Bytes(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function isArchivableFile(fullPath: string, root: string): boolean {
  const relativePath = relative(root, fullPath);
  if (relativePath === "" || relativePath.startsWith("..") || resolve(root, relativePath) !== fullPath) {
    return false;
  }
  const base = basename(fullPath);
  if (base.startsWith(".") || base.toLowerCase().startsWith(".env") || base === "desktop.ini") {
    return false;
  }
  try {
    return lstatSync(fullPath).isFile();
  } catch {
    return false;
  }
}

interface WalkedFile {
  memberName: string;
  fullPath: string;
  bytes: number;
}

/** Depth-first walk that never follows symlinks and skips dot/secret files. */
export function walkArchiveDir(dir: string, prefix: string): WalkedFile[] {
  const found: WalkedFile[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const fullPath = join(current, entry);
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!stat.isFile() || !isArchivableFile(fullPath, dir)) {
        continue;
      }
      found.push({
        memberName: `${prefix}/${relative(dir, fullPath).split(sep).join("/")}`,
        fullPath,
        bytes: stat.size,
      });
      if (found.length > MAX_BACKUP_FILES) {
        throw new BackupError(`backup exceeds the ${MAX_BACKUP_FILES} file limit`);
      }
    }
  }
  return found.sort((left, right) => (left.memberName < right.memberName ? -1 : 1));
}

export interface BackupInput {
  handle: DatabaseHandle;
  paths: DataRootPaths;
  candidateDir: string;
  stagingDir: string;
  kind: BackupManifestV1["kind"];
  now: Date;
}

export interface BackupResult {
  bytes: Buffer;
  filename: string;
  manifest: BackupManifestV1;
}

/**
 * Create a backup archive. Checkpoints WAL, copies the live database via
 * the online backup API into staging, then archives database + evidence +
 * artifacts + candidate profile with a manifest. Throws `BackupError` on
 * any failure; callers must treat a throw as "no backup was produced".
 */
export async function createBackupArchive(input: BackupInput): Promise<BackupResult> {
  const { handle, paths, candidateDir, stagingDir, kind, now } = input;
  mkdirSync(stagingDir, { recursive: true });
  handle.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const stagedDb = join(stagingDir, "job-tracker.sqlite");
  await handle.sqlite.backup(stagedDb);
  const jobCount = (
    handle.sqlite.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }
  ).count;

  const files: WalkedFile[] = [
    ...walkArchiveDir(paths.evidenceDir, "evidence"),
    ...walkArchiveDir(paths.artifactsDir, "artifacts"),
    ...walkArchiveDir(candidateDir, "candidate"),
  ];
  const mtimeSeconds = Math.floor(now.getTime() / 1000);
  const writer = createTarWriter(mtimeSeconds);
  const members: BackupManifestV1["members"] = [];
  let totalBytes = 0;
  const appendMember = (name: string, data: Buffer): void => {
    if (data.length > MAX_BACKUP_FILE_BYTES) {
      throw new BackupError(`backup member exceeds the file size limit: ${name.slice(0, 60)}`);
    }
    totalBytes += data.length;
    if (totalBytes > MAX_BACKUP_UNCOMPRESSED_BYTES) {
      throw new BackupError("backup exceeds the 1 GiB uncompressed limit");
    }
    writer.appendFile(name, data);
    members.push({ name, bytes: data.length, sha256: sha256Bytes(data) });
  };

  const dbBytes = readFileSync(stagedDb);
  appendMember(DATABASE_MEMBER, dbBytes);
  const databaseEntry = members[0] as BackupManifestV1["database"];
  for (const file of files) {
    appendMember(file.memberName, readFileSync(file.fullPath));
  }
  const manifest: BackupManifestV1 = {
    schemaVersion: BACKUP_MANIFEST_VERSION,
    createdAt: now.toISOString(),
    kind,
    database: { name: databaseEntry.name, bytes: databaseEntry.bytes, sha256: databaseEntry.sha256 },
    members: members.filter((member) => member.name !== DATABASE_MEMBER),
    counts: { jobs: jobCount },
  };
  writer.appendFile(MANIFEST_MEMBER, Buffer.from(JSON.stringify(manifest), "utf8"));
  const bytes = gzipTar(writer.finish(), mtimeSeconds);
  return {
    bytes,
    filename:
      kind === "manual" ? backupFilenameFor(now) : safetyBackupFilenameFor(kind, now),
    manifest,
  };
}

export interface VerifiedArchive {
  manifest: BackupManifestV1;
  members: Map<string, Buffer>;
}

const TAR_SLACK_BYTES = 1_048_576;

/**
 * Gunzip, strictly untar, and verify an uploaded archive against its own
 * manifest: exact member set (no extras, no missing), per-member hashes,
 * and database entry consistency. Pure bytes-in check; touches nothing
 * live. Throws `BackupError` naming the first defect.
 */
export function parseAndVerifyArchive(archive: Buffer): VerifiedArchive {
  let members: Array<{ name: string; data: Buffer }>;
  try {
    const tarBytes = gunzipTar(archive, MAX_BACKUP_UNCOMPRESSED_BYTES + TAR_SLACK_BYTES);
    members = extractTarStrict(tarBytes, {
      maxFiles: MAX_BACKUP_FILES,
      maxFileBytes: MAX_BACKUP_FILE_BYTES,
      maxTotalBytes: MAX_BACKUP_UNCOMPRESSED_BYTES,
    });
  } catch (error: unknown) {
    if (error instanceof BackupError) {
      throw error;
    }
    throw new BackupError(`archive rejected: ${(error as Error).message}`);
  }
  const byName = new Map(members.map((member) => [member.name, member.data]));
  const manifestRaw = byName.get(MANIFEST_MEMBER);
  if (manifestRaw === undefined) {
    throw new BackupError("archive is missing its manifest");
  }
  let manifest: BackupManifestV1;
  try {
    manifest = BackupManifestV1.parse(JSON.parse(manifestRaw.toString("utf8")) as unknown);
  } catch (error: unknown) {
    throw new BackupError(`archive manifest rejected: ${(error as Error).message}`);
  }
  const expected = new Map<string, string>();
  expected.set(manifest.database.name, manifest.database.sha256);
  for (const member of manifest.members) {
    expected.set(member.name, member.sha256);
  }
  if (manifest.database.name !== DATABASE_MEMBER) {
    throw new BackupError("archive manifest names an unexpected database member");
  }
  for (const [name, data] of byName) {
    if (name === MANIFEST_MEMBER) {
      continue;
    }
    const want = expected.get(name);
    if (want === undefined) {
      throw new BackupError(`archive carries an unmanifested member: ${name.slice(0, 60)}`);
    }
    if (sha256Bytes(data) !== want) {
      throw new BackupError(`archive member failed its hash: ${name.slice(0, 60)}`);
    }
  }
  for (const name of expected.keys()) {
    if (!byName.has(name)) {
      throw new BackupError(`archive is missing a manifested member: ${name.slice(0, 60)}`);
    }
  }
  return { manifest, members: byName };
}

export interface StagedDatabaseReport {
  jobs: number;
  migrations: string[];
}

/**
 * Validate a staged database file on a throwaway connection: SQLite
 * integrity, required product tables, and a migration ceiling (backups
 * from a newer app are refused; older ones migrate forward on boot).
 */
export function verifyStagedDatabase(
  openStaging: () => DatabaseHandle,
  migrationsDir: string,
): StagedDatabaseReport {
  let handle: DatabaseHandle | null = null;
  try {
    try {
      handle = openStaging();
    } catch (error: unknown) {
      throw new BackupError(`staged database unreadable: ${(error as Error).message}`);
    }
    const integrity = handle.sqlite
      .prepare("PRAGMA integrity_check")
      .all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new BackupError("staged database failed SQLite integrity_check");
    }
    const tables = new Set(
      (
        handle.sqlite
          .prepare("SELECT name AS name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    for (const required of ["jobs", "_schema_migrations", "candidate_profiles"]) {
      if (!tables.has(required)) {
        throw new BackupError(`staged database is missing table: ${required}`);
      }
    }
    const known = new Set(discoverMigrationFiles(migrationsDir).map((file) => file.version));
    const applied = (
      handle.sqlite.prepare("SELECT version AS version FROM _schema_migrations").all() as Array<{
        version: string;
      }>
    ).map((row) => row.version);
    for (const version of applied) {
      if (!known.has(version)) {
        throw new BackupError(
          `backup database targets unknown migration ${version}; it comes from a newer app`,
        );
      }
    }
    const jobs = (
      handle.sqlite.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }
    ).count;
    return { jobs, migrations: applied };
  } finally {
    handle?.close();
  }
}

/** Read the worker reopen generation marker (null when never restored/reset). */
export function readGeneration(root: string): string | null {
  try {
    const raw = readFileSync(join(root, GENERATION_FILENAME), "utf8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

/** Bump the generation marker so the worker reopens its database handle. */
export function writeGeneration(root: string, stamp: string): string {
  const value = `${stamp}:${randomBytes(8).toString("hex")}`;
  const path = join(root, GENERATION_FILENAME);
  writeFileSync(path, `${value}\n`, "utf8");
  return value;
}

function removeIfExists(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; stale leftovers are retried on the next run.
  }
}

/** Remove `*.prev-*` leftovers from an interrupted swap (idempotent). */
export function cleanupSwapLeftovers(paths: DataRootPaths, candidateDir: string): void {
  for (const dir of [dirname(paths.databasePath), dirname(paths.evidenceDir), dirname(paths.artifactsDir), dirname(candidateDir)]) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.includes(".prev-")) {
        removeIfExists(join(dir, entry));
      }
    }
  }
}

function atomicFileSwap(livePath: string, stagedPath: string, stamp: string): void {
  const prevPath = `${livePath}.prev-${stamp}`;
  if (existsSync(livePath)) {
    renameSync(livePath, prevPath);
  }
  renameSync(stagedPath, livePath);
  removeIfExists(prevPath);
}

export interface RestoreInput {
  handle: DatabaseHandle;
  paths: DataRootPaths;
  candidateDir: string;
  stagingRoot: string;
  migrationsDir: string;
  openStaging: (stagedDbPath: string) => DatabaseHandle;
  archive: Buffer;
  now: Date;
}

export interface RestoreResult {
  manifest: BackupManifestV1;
  preRestoreBackup: string;
  jobs: number;
}

const PRESERVED_TABLES_IN_FK_ORDER = [
  "candidate_profiles",
  "candidate_profile_versions",
  "candidate_facts",
  "candidate_snapshots",
  "candidate_snapshot_facts",
] as const;

export interface ResetInput {
  handle: DatabaseHandle;
  paths: DataRootPaths;
  candidateDir: string;
  stagingRoot: string;
  openDatabaseAt: (dbPath: string) => DatabaseHandle;
  runMigrations: (handle: DatabaseHandle) => void;
  now: Date;
}

export interface ResetResult {
  deletedJobs: number;
  preResetBackup: string;
  preservedProfile: boolean;
}

/**
 * Board reset ("Clear All Jobs"). DELETEs cannot express this: BEFORE
 * DELETE triggers guard evidence/attempt/extraction/analysis/snapshot
 * history, so reset rebuilds instead — a fresh migrated database keeps
 * only the five candidate tables, evidence/artifact trees are emptied,
 * and the candidate source dir is preserved. A pre-reset backup is taken
 * first (architecture §8); the worker generation is bumped so the
 * worker reopens without a restart. The live handle must not be used
 * after this resolves.
 */
export async function resetBoardData(input: ResetInput): Promise<ResetResult> {
  const { handle, paths, candidateDir, stagingRoot, openDatabaseAt, runMigrations, now } =
    input;
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
  const stagingDir = join(stagingRoot, `reset-${stamp}`);
  mkdirSync(stagingDir, { recursive: true });
  try {
    const deletedJobs = (
      handle.sqlite.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }
    ).count;
    const backupsDir = join(paths.root, BACKUPS_DIR_NAME);
    mkdirSync(backupsDir, { recursive: true });
    const safety = await createBackupArchive({
      handle,
      paths,
      candidateDir,
      stagingDir: join(stagingDir, "pre-reset"),
      kind: "pre-reset",
      now,
    });
    const safetyPath = join(backupsDir, safety.filename);
    if (existsSync(safetyPath)) {
      throw new BackupError("pre-reset backup filename already exists; retry in a second");
    }
    writeFileSync(safetyPath, safety.bytes);

    const freshPath = join(stagingDir, "job-tracker.sqlite");
    const fresh = openDatabaseAt(freshPath);
    try {
      runMigrations(fresh);
      const escapedLive = paths.databasePath.replace(/'/g, "''");
      fresh.sqlite.exec(`ATTACH '${escapedLive}' AS old_root`);
      try {
        for (const table of PRESERVED_TABLES_IN_FK_ORDER) {
          fresh.sqlite.exec(`INSERT INTO main."${table}" SELECT * FROM old_root."${table}"`);
        }
      } finally {
        fresh.sqlite.exec("DETACH old_root");
      }
      const integrity = fresh.sqlite
        .prepare("PRAGMA integrity_check")
        .all() as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
        throw new BackupError("reset database failed SQLite integrity_check");
      }
    } finally {
      fresh.close();
    }
    const preservedProfile =
      (
        handle.sqlite.prepare("SELECT COUNT(*) AS count FROM candidate_profiles").get() as {
          count: number;
        }
      ).count > 0;

    cleanupSwapLeftovers(paths, candidateDir);
    atomicFileSwap(paths.databasePath, freshPath, stamp);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = `${paths.databasePath}${suffix}`;
      if (existsSync(sidecar)) {
        unlinkSync(sidecar);
      }
    }
    for (const tree of [paths.evidenceDir, paths.artifactsDir]) {
      let entries: string[];
      try {
        entries = readdirSync(tree);
      } catch {
        mkdirSync(tree, { recursive: true });
        continue;
      }
      for (const entry of entries) {
        removeIfExists(join(tree, entry));
      }
    }
    writeGeneration(paths.root, now.toISOString());
    return { deletedJobs, preResetBackup: safety.filename, preservedProfile };
  } finally {
    removeIfExists(stagingDir);
  }
}

/**
 * Full restore orchestration: verify the upload in staging, take a
 * pre-restore backup, validate the staged database, then crash-recoverably
 * swap database + directories and bump the worker generation. The live
 * handle must not be used after this resolves — its file was replaced.
 */
export async function restoreArchive(input: RestoreInput): Promise<RestoreResult> {
  const { handle, paths, candidateDir, stagingRoot, migrationsDir, openStaging, archive, now } =
    input;
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
  const stagingDir = join(stagingRoot, `restore-${stamp}`);
  mkdirSync(stagingDir, { recursive: true });
  try {
    const verified = parseAndVerifyArchive(archive);
    const stagedDbPath = join(stagingDir, "job-tracker.sqlite");
    writeFileSync(stagedDbPath, verified.members.get(DATABASE_MEMBER) as Buffer);
    const report = verifyStagedDatabase(() => openStaging(stagedDbPath), migrationsDir);

    const backupsDir = join(paths.root, BACKUPS_DIR_NAME);
    mkdirSync(backupsDir, { recursive: true });
    const safety = await createBackupArchive({
      handle,
      paths,
      candidateDir,
      stagingDir: join(stagingDir, "pre-restore"),
      kind: "pre-restore",
      now,
    });
    const safetyPath = join(backupsDir, safety.filename);
    if (existsSync(safetyPath)) {
      throw new BackupError("pre-restore backup filename already exists; retry in a second");
    }
    writeFileSync(safetyPath, safety.bytes);

    cleanupSwapLeftovers(paths, candidateDir);
    const stagedDirs = {
      evidence: join(stagingDir, "evidence"),
      artifacts: join(stagingDir, "artifacts"),
      candidate: join(stagingDir, "candidate"),
    };
    mkdirSync(stagedDirs.evidence, { recursive: true });
    mkdirSync(stagedDirs.artifacts, { recursive: true });
    mkdirSync(stagedDirs.candidate, { recursive: true });
    for (const [name, data] of verified.members) {
      if (name === MANIFEST_MEMBER || name === DATABASE_MEMBER) {
        continue;
      }
      const slash = name.indexOf("/");
      const top = slash === -1 ? "" : name.slice(0, slash);
      const rest = slash === -1 ? "" : name.slice(slash + 1);
      const targetRoot =
        top === "evidence"
          ? stagedDirs.evidence
          : top === "artifacts"
            ? stagedDirs.artifacts
            : top === "candidate"
              ? stagedDirs.candidate
              : null;
      if (targetRoot === null || rest === "") {
        throw new BackupError(`archive member targets an unknown root: ${name.slice(0, 60)}`);
      }
      const target = join(targetRoot, ...rest.split("/"));
      if (relative(targetRoot, target).startsWith("..")) {
        throw new BackupError(`archive member escapes its target: ${name.slice(0, 60)}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
    }

    atomicFileSwap(paths.databasePath, stagedDbPath, stamp);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = `${paths.databasePath}${suffix}`;
      if (existsSync(sidecar)) {
        unlinkSync(sidecar);
      }
    }
    atomicFileSwap(paths.evidenceDir, stagedDirs.evidence, stamp);
    atomicFileSwap(paths.artifactsDir, stagedDirs.artifacts, stamp);
    atomicFileSwap(candidateDir, stagedDirs.candidate, stamp);
    writeGeneration(paths.root, now.toISOString());
    return { manifest: verified.manifest, preRestoreBackup: safety.filename, jobs: report.jobs };
  } finally {
    removeIfExists(stagingDir);
  }
}
