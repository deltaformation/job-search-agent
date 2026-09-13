// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../../../src/db/client";
import { migrate } from "../../../src/db/migrate";
import { resolveMigrationsDir } from "../../../src/db/testing";
import {
  DATABASE_MEMBER,
  MANIFEST_MEMBER,
  BackupError,
  backupFilenameFor,
  createBackupArchive,
  parseAndVerifyArchive,
  readGeneration,
  resetBoardData,
  restoreArchive,
  sha256Bytes,
  verifyStagedDatabase,
  walkArchiveDir,
  writeGeneration,
} from "../../../src/server/backup";
import {
  ensureDataRoot,
  resolveDataRoot,
  type DataRootPaths,
} from "../../../src/security/data-root";
import { createTarWriter, gzipTar } from "../../../src/server/tar";

const tempDirs: string[] = [];
const handles: DatabaseHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoot(withJob: boolean): { root: string; paths: DataRootPaths; candidateDir: string } {
  const root = mkdtempSync(join(tmpdir(), "job-tracker-backup-test-"));
  tempDirs.push(root);
  const paths = resolveDataRoot({ APP_DATA_ROOT: root });
  ensureDataRoot(paths);
  const handle = openDatabase({ path: paths.databasePath });
  handles.push(handle);
  migrate(handle.sqlite, { migrationsDir: resolveMigrationsDir() });
  if (withJob) {
    handle.sqlite
      .prepare("INSERT INTO jobs (id, status, rank, row_version) VALUES ('job-1', 'NEW', 0, 1)")
      .run();
  }
  const candidateDir = join(root, "candidate");
  mkdirSync(candidateDir, { recursive: true });
  writeFileSync(join(candidateDir, "master-resume.json"), '{"v":1}');
  return { root, paths, candidateDir };
}

function seedFiles(paths: DataRootPaths): void {
  writeFileSync(join(paths.evidenceDir, "abc123"), "<html>raw</html>");
  mkdirSync(join(paths.artifactsDir, "ver-1"), { recursive: true });
  writeFileSync(join(paths.artifactsDir, "ver-1", "resume.md"), "# Resume");
}

describe("walkArchiveDir", () => {
  it("skips symlinks, dotfiles, and secret names", () => {
    const { paths } = makeRoot(false);
    writeFileSync(join(paths.evidenceDir, "ok.bin"), "ok");
    writeFileSync(join(paths.evidenceDir, ".hidden"), "no");
    writeFileSync(join(paths.evidenceDir, ".env.local"), "secret");
    try {
      symlinkSync(join(paths.evidenceDir, "ok.bin"), join(paths.evidenceDir, "link.bin"));
    } catch {
      // Filesystems without symlink rights skip that case; the walk still guards.
    }
    const found = walkArchiveDir(paths.evidenceDir, "evidence").map((file) => file.memberName);
    expect(found).toEqual(["evidence/ok.bin"]);
  });
});

describe("createBackupArchive", () => {
  it("archives database, evidence, artifacts, and candidate with a manifest", async () => {
    const { paths, candidateDir } = makeRoot(true);
    seedFiles(paths);
    const handle = openDatabase({ path: paths.databasePath });
    handles.push(handle);
    const staging = join(paths.root, "staging");
    const result = await createBackupArchive({
      handle,
      paths,
      candidateDir,
      stagingDir: staging,
      kind: "manual",
      now: new Date("2026-09-12T09:00:00.000Z"),
    });
    expect(result.filename).toBe("job-tracker-backup-2026-09-12.tar.gz");
    expect(result.manifest.counts.jobs).toBe(1);
    const verified = parseAndVerifyArchive(result.bytes);
    expect([...verified.members.keys()].sort()).toEqual([
      "artifacts/ver-1/resume.md",
      "candidate/master-resume.json",
      "evidence/abc123",
      MANIFEST_MEMBER,
      DATABASE_MEMBER,
    ]);
    expect(verified.manifest.database.sha256).toBe(result.manifest.database.sha256);
  });

  it("captures uncheckpointed WAL frames through the backup API", async () => {
    const { paths, candidateDir } = makeRoot(false);
    const handle = openDatabase({ path: paths.databasePath });
    handles.push(handle);
    handle.sqlite
      .prepare("INSERT INTO jobs (id, status, rank, row_version) VALUES ('job-wal', 'NEW', 0, 1)")
      .run();
    const result = await createBackupArchive({
      handle,
      paths,
      candidateDir,
      stagingDir: join(paths.root, "staging"),
      kind: "manual",
      now: new Date("2026-09-12T09:00:00.000Z"),
    });
    expect(result.manifest.counts.jobs).toBe(1);
    expect(backupFilenameFor(new Date("2026-01-02T03:04:05.000Z"))).toBe(
      "job-tracker-backup-2026-01-02.tar.gz",
    );
  });
});

describe("parseAndVerifyArchive", () => {
  async function validArchive(): Promise<Buffer> {
    const { paths, candidateDir } = makeRoot(true);
    seedFiles(paths);
    const handle = openDatabase({ path: paths.databasePath });
    handles.push(handle);
    const result = await createBackupArchive({
      handle,
      paths,
      candidateDir,
      stagingDir: join(paths.root, "staging"),
      kind: "manual",
      now: new Date("2026-09-12T09:00:00.000Z"),
    });
    return result.bytes;
  }

  it("rejects tampered, padded, and incomplete archives", async () => {
    const good = await validArchive();
    const tampered = Buffer.from(good);
    tampered[tampered.length - 20] = ((tampered[tampered.length - 20] as number) + 1) % 256;
    expect(() => parseAndVerifyArchive(tampered)).toThrow(BackupError);

    const writer = createTarWriter(0);
    const dbBytes = Buffer.from("db");
    writer.appendFile(DATABASE_MEMBER, dbBytes);
    const legitBytes = Buffer.from("legit");
    writer.appendFile("evidence/legit", legitBytes);
    const manifest = {
      schemaVersion: "backup-manifest/v1",
      createdAt: "2026-09-12T09:00:00.000Z",
      kind: "manual",
      database: {
        name: DATABASE_MEMBER,
        bytes: dbBytes.length,
        sha256: sha256Bytes(dbBytes),
      },
      members: [
        { name: "evidence/legit", bytes: legitBytes.length, sha256: sha256Bytes(legitBytes) },
      ],
      counts: { jobs: 0 },
    };
    writer.appendFile(MANIFEST_MEMBER, Buffer.from(JSON.stringify(manifest)));
    writer.appendFile("evidence/stowaway", Buffer.from("x"));
    expect(() => parseAndVerifyArchive(gzipTar(writer.finish(), 0))).toThrow(/unmanifested/);

    const missing = createTarWriter(0);
    missing.appendFile(MANIFEST_MEMBER, Buffer.from(JSON.stringify(manifest)));
    expect(() => parseAndVerifyArchive(gzipTar(missing.finish(), 0))).toThrow(
      /missing a manifested member/,
    );

    const noManifest = createTarWriter(0);
    noManifest.appendFile(DATABASE_MEMBER, Buffer.from("db"));
    expect(() => parseAndVerifyArchive(gzipTar(noManifest.finish(), 0))).toThrow(
      /missing its manifest/,
    );
    expect(() => parseAndVerifyArchive(Buffer.from("garbage"))).toThrow(BackupError);
  });
});

describe("verifyStagedDatabase", () => {
  it("accepts a migrated copy and rejects corrupt or newer databases", () => {
    const { paths } = makeRoot(true);
    expect(
      verifyStagedDatabase(
        () => {
          const handle = openDatabase({ path: paths.databasePath });
          handles.push(handle);
          return handle;
        },
        resolveMigrationsDir(),
      ).jobs,
    ).toBe(1);

    const garbagePath = join(paths.root, "garbage.sqlite");
    writeFileSync(garbagePath, Buffer.from("definitely not sqlite"));
    expect(() =>
      verifyStagedDatabase(
        () => {
          const handle = openDatabase({ path: garbagePath });
          handles.push(handle);
          return handle;
        },
        resolveMigrationsDir(),
      ),
    ).toThrow(BackupError);

    const handle = openDatabase({ path: paths.databasePath });
    handles.push(handle);
    handle.sqlite
      .prepare("INSERT INTO _schema_migrations (version, sha256) VALUES ('9999_future.sql', 'x')")
      .run();
    expect(() =>
      verifyStagedDatabase(
        () => {
          const reopened = openDatabase({ path: paths.databasePath });
          handles.push(reopened);
          return reopened;
        },
        resolveMigrationsDir(),
      ),
    ).toThrow(/newer app/);
  });
});

describe("generation marker", () => {
  it("round-trips and defaults to null", () => {
    const { root } = makeRoot(false);
    expect(readGeneration(root)).toBeNull();
    const first = writeGeneration(root, "2026-09-12T09:00:00.000Z");
    expect(readGeneration(root)).toBe(first);
    const second = writeGeneration(root, "2026-09-12T09:00:00.000Z");
    expect(second).not.toBe(first);
    expect(readGeneration(root)).toBe(second);
  });
});

describe("restoreArchive", () => {
  it("verifies, pre-backs-up, swaps, and bumps the generation", async () => {
    const { root, paths, candidateDir } = makeRoot(true);
    seedFiles(paths);
    const handle = openDatabase({ path: paths.databasePath });
    handles.push(handle);
    const snapshot = await createBackupArchive({
      handle,
      paths,
      candidateDir,
      stagingDir: join(paths.root, "staging-snap"),
      kind: "manual",
      now: new Date("2026-09-12T09:00:00.000Z"),
    });

    // Mutate the live tree: new job, new files, changed candidate profile.
    handle.sqlite
      .prepare("INSERT INTO jobs (id, status, rank, row_version) VALUES ('job-2', 'NEW', 1, 1)")
      .run();
    writeFileSync(join(paths.evidenceDir, "new-stuff"), "new");
    writeFileSync(join(candidateDir, "master-resume.json"), '{"v":2}');

    const result = await restoreArchive({
      handle,
      paths,
      candidateDir,
      stagingRoot: join(paths.root, "staging"),
      migrationsDir: resolveMigrationsDir(),
      openStaging: (stagedDbPath: string) => openDatabase({ path: stagedDbPath }),
      archive: snapshot.bytes,
      now: new Date("2026-09-12T10:00:00.000Z"),
    });
    expect(result.jobs).toBe(1);
    expect(result.preRestoreBackup).toMatch(/^pre-restore-20260912T100000Z\.tar\.gz$/);
    handle.close();

    // The live tree now matches the snapshot, and the safety backup holds 2 jobs.
    const reopened = openDatabase({ path: paths.databasePath });
    handles.push(reopened);
    const jobs = reopened.sqlite.prepare("SELECT id AS id FROM jobs ORDER BY id").all() as Array<{
      id: string;
    }>;
    expect(jobs.map((row) => row.id)).toEqual(["job-1"]);
    expect(
      reopened.sqlite.prepare("SELECT version AS version FROM _schema_migrations").all(),
    ).toHaveLength(6);
    const { readFileSync: read } = await import("node:fs");
    expect(read(join(candidateDir, "master-resume.json"), "utf8")).toBe('{"v":1}');
    expect(read(join(paths.evidenceDir, "abc123"), "utf8")).toBe("<html>raw</html>");
    const { existsSync: exists } = await import("node:fs");
    expect(exists(join(paths.evidenceDir, "new-stuff"))).toBe(false);
    expect(readGeneration(root)).not.toBeNull();

    const safetyBytes = read(join(paths.root, "backups", result.preRestoreBackup));
    expect(parseAndVerifyArchive(safetyBytes).manifest.counts.jobs).toBe(2);
  });

});

describe("resetBoardData", () => {
  it("rebuilds an empty board while preserving the candidate profile", async () => {
    const { root, paths, candidateDir } = makeRoot(true);
    seedFiles(paths);
    const handle = openDatabase({ path: paths.databasePath });
    handles.push(handle);
    handle.sqlite
      .prepare(
        "INSERT INTO candidate_profiles (id, name, display_name, is_default) VALUES ('local', 'default', 'Primary Profile', 1)",
      )
      .run();
    const versionId = "version-1";
    handle.sqlite
      .prepare(
        "INSERT INTO candidate_profile_versions (id, profile_id, version, payload_json, payload_hash, schema_version) VALUES (?, 'local', 1, '{}', ?, 'candidate-profile-v1')",
      )
      .run(versionId, "a".repeat(64));
    handle.sqlite
      .prepare(
        "INSERT INTO candidate_facts (fact_id, profile_version_id, kind, statement, verification) VALUES ('f1', ?, 'achievement', 'Did things.', 'APPROVED')",
      )
      .run(versionId);
    handle.sqlite
      .prepare(
        "INSERT INTO intake_batches (id, raw_line_count, enqueued_count, duplicate_count, invalid_count, blocked_count) VALUES ('batch-1', 1, 1, 0, 0, 0)",
      )
      .run();

    const result = await resetBoardData({
      handle,
      paths,
      candidateDir,
      stagingRoot: join(paths.root, "staging"),
      openDatabaseAt: (dbPath: string) => openDatabase({ path: dbPath }),
      runMigrations: (fresh: DatabaseHandle) =>
        migrate(fresh.sqlite, { migrationsDir: resolveMigrationsDir() }),
      now: new Date("2026-09-12T11:00:00.000Z"),
    });
    expect(result).toEqual({
      deletedJobs: 1,
      preResetBackup: "pre-reset-20260912T110000Z.tar.gz",
      preservedProfile: true,
    });
    handle.close();

    const reopened = openDatabase({ path: paths.databasePath });
    handles.push(reopened);
    const count = (table: string): number =>
      (reopened.sqlite.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number })
        .count;
    for (const table of [
      "jobs",
      "job_sources",
      "job_extractions",
      "resume_versions",
      "work_items",
      "intake_batches",
      "workflow_events",
      "jd_snapshots",
      "job_analyses",
    ]) {
      expect(count(table), table).toBe(0);
    }
    expect(count("candidate_profiles")).toBe(1);
    expect(count("candidate_profile_versions")).toBe(1);
    expect(count("candidate_facts")).toBe(1);
    const tables = reopened.sqlite
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'")
      .get() as { count: number };
    expect(tables.count).toBeGreaterThan(20);
    const { existsSync: exists, readFileSync: read, readdirSync: readDir } =
      await import("node:fs");
    expect(readDir(paths.evidenceDir)).toEqual([]);
    expect(readDir(paths.artifactsDir)).toEqual([]);
    expect(read(join(candidateDir, "master-resume.json"), "utf8")).toBe('{"v":1}');
    expect(readGeneration(root)).not.toBeNull();
    expect(exists(join(paths.root, "backups", result.preResetBackup))).toBe(true);
    const safety = parseAndVerifyArchive(read(join(paths.root, "backups", result.preResetBackup)));
    expect(safety.manifest.counts.jobs).toBe(1);
  });

});

describe("restoreArchive failure", () => {
  it("refuses a corrupt archive without touching the live tree", async () => {
    const { root, paths, candidateDir } = makeRoot(true);
    const handle = openDatabase({ path: paths.databasePath });
    handles.push(handle);
    await expect(
      restoreArchive({
        handle,
        paths,
        candidateDir,
        stagingRoot: join(paths.root, "staging"),
        migrationsDir: resolveMigrationsDir(),
        openStaging: (stagedDbPath: string) => openDatabase({ path: stagedDbPath }),
        archive: Buffer.from("corrupt"),
        now: new Date("2026-09-12T10:00:00.000Z"),
      }),
    ).rejects.toThrow(BackupError);
    const jobs = handle.sqlite.prepare("SELECT COUNT(*) AS count FROM jobs").get() as {
      count: number;
    };
    expect(jobs.count).toBe(1);
    expect(readGeneration(root)).toBeNull();
  });
});
