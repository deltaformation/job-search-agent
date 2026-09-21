// @vitest-environment node
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../../../src/db/client";
import { migrate } from "../../../src/db/migrate";
import { resolveMigrationsDir } from "../../../src/db/testing";
import {
  createBackupArchive,
  parseAndVerifyArchive,
  resetBoardData,
  restoreArchive,
} from "../../../src/server/backup";
import { importMasterDocument, readActiveMasterSource } from "../../../src/server/settings";
import { backfillProfileSources } from "../../../src/server/sources";
import {
  ensureDataRoot,
  resolveDataRoot,
  type DataRootPaths,
} from "../../../src/security/data-root";

/**
 * WO-1.2-B gate B4 (backup/reset slice): profile sources ride backups
 * with hash verification, restore by swap, rebuild from payloads when
 * restoring a pre-sources archive, and survive board resets.
 */

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

function makeRoot(): { root: string; paths: DataRootPaths; candidateDir: string } {
  const root = mkdtempSync(join(tmpdir(), "job-tracker-b4-sources-"));
  tempDirs.push(root);
  const paths = resolveDataRoot({ APP_DATA_ROOT: root });
  ensureDataRoot(paths);
  const handle = openDatabase({ path: paths.databasePath });
  handles.push(handle);
  migrate(handle.sqlite, { migrationsDir: resolveMigrationsDir() });
  const candidateDir = join(root, "candidate");
  return { root, paths, candidateDir };
}

/**
 * Genuine pre-B database: migrated only through 0005 so the 0006 ledger
 * entry and `candidate_sources` table are both absent, exactly like an
 * old backup. (Dropping the table from a 0006-migrated DB leaves the
 * ledger entry, so a later migrate() would wrongly no-op.)
 */
function makeLegacyRoot(): { root: string; paths: DataRootPaths; candidateDir: string } {
  const root = mkdtempSync(join(tmpdir(), "job-tracker-b4-legacy-"));
  tempDirs.push(root);
  const paths = resolveDataRoot({ APP_DATA_ROOT: root });
  ensureDataRoot(paths);
  const realDir = resolveMigrationsDir();
  const legacyDir = mkdtempSync(join(tmpdir(), "job-tracker-b4-legacy-migrations-"));
  tempDirs.push(legacyDir);
  for (const file of readdirSync(realDir)) {
    if (file.endsWith(".sql") && file < "0006_profile_sources.sql") {
      copyFileSync(join(realDir, file), join(legacyDir, file));
    }
  }
  const handle = openDatabase({ path: paths.databasePath });
  handles.push(handle);
  migrate(handle.sqlite, { migrationsDir: legacyDir });
  const candidateDir = join(root, "candidate");
  return { root, paths, candidateDir };
}

function pmFixture(): unknown {
  return JSON.parse(
    readFileSync(join(process.cwd(), "tests", "fixtures", "v1.2", "pm-profile.json"), "utf8"),
  ) as unknown;
}

describe("profile sources in backup, restore, and reset (B4)", () => {
  it("backs up sources with hashes and restores them by swap", async () => {
    const { paths, candidateDir } = makeRoot();
    const handle = openDatabase({ path: paths.databasePath });
    handles.push(handle);
    const imported = importMasterDocument(handle, {
      document: pmFixture(),
      origin: "upload",
      sourcesDir: paths.sourcesDir,
    });
    if (!imported.ok) {
      throw new Error("import failed");
    }
    const snapshot = await createBackupArchive({
      handle,
      paths,
      candidateDir,
      stagingDir: join(paths.root, "staging-snap"),
      kind: "manual",
      now: new Date("2026-09-12T09:00:00.000Z"),
    });
    const members = snapshot.manifest.members.map((member) => member.name);
    expect(members.some((name) => name.startsWith("sources/") && name.endsWith(".json"))).toBe(true);
    const verified = parseAndVerifyArchive(snapshot.bytes);
    expect([...verified.members.keys()].some((name) => name.startsWith("sources/"))).toBe(true);

    // Mutate the live tree: delete the source bytes and add a job.
    const read = readActiveMasterSource(handle, paths.sourcesDir);
    if (!read.ok) {
      throw new Error("source read failed");
    }
    rmSync(join(paths.sourcesDir, `${read.profileId}`, `${read.versionId}.json`));
    handle.sqlite
      .prepare("INSERT INTO jobs (id, status, rank, row_version) VALUES ('job-2', 'NEW', 1, 1)")
      .run();

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
    expect(result.jobs).toBe(0);
    handle.close();

    const reopened = openDatabase({ path: paths.databasePath });
    handles.push(reopened);
    const restored = readActiveMasterSource(reopened, paths.sourcesDir);
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.bytes.toString("utf8")).toContain('"pm-fact-discovery"');
    }
  });

  it("rebuilds sources from payloads when restoring a pre-sources archive", async () => {
    const { paths, candidateDir } = makeLegacyRoot();
    const handle = openDatabase({ path: paths.databasePath });
    handles.push(handle);
    // Seed legacy rows with raw SQL: the current Drizzle schema lists
    // columns these old tables predate.
    handle.sqlite
      .prepare(
        "INSERT INTO candidate_profiles (id, name, display_name, is_default) VALUES ('pm', 'pm', 'PM', 1)",
      )
      .run();
    const payload = { ...(pmFixture() as Record<string, unknown>), schemaVersion: "candidate-profile/v1" };
    handle.sqlite
      .prepare(
        "INSERT INTO candidate_profile_versions (id, profile_id, version, payload_json, payload_hash, schema_version, activated_at) VALUES ('v1', 'pm', 1, ?, 'hash', 'candidate-profile/v1', '2026-09-01T00:00:00.000Z')",
      )
      .run(JSON.stringify(payload));
    // Archives require at least one file member; old backups always had evidence.
    writeFileSync(join(paths.evidenceDir, "page"), "<html>old</html>");
    const snapshot = await createBackupArchive({
      handle,
      paths,
      candidateDir,
      stagingDir: join(paths.root, "staging-snap"),
      kind: "manual",
      now: new Date("2026-09-12T09:00:00.000Z"),
    });
    expect(snapshot.manifest.members.some((member) => member.name.startsWith("sources/"))).toBe(false);
    handle.close();

    const target = makeRoot();
    const live = openDatabase({ path: target.paths.databasePath });
    handles.push(live);
    await restoreArchive({
      handle: live,
      paths: target.paths,
      candidateDir: target.candidateDir,
      stagingRoot: join(target.paths.root, "staging"),
      migrationsDir: resolveMigrationsDir(),
      openStaging: (stagedDbPath: string) => openDatabase({ path: stagedDbPath }),
      archive: snapshot.bytes,
      now: new Date("2026-09-12T10:00:00.000Z"),
    });
    live.close();

    // Boot path after restore: migrate forward, then backfill sources.
    const booted = openDatabase({ path: target.paths.databasePath });
    handles.push(booted);
    migrate(booted.sqlite, { migrationsDir: resolveMigrationsDir() });
    const report = backfillProfileSources(booted, {
      sourcesDir: target.paths.sourcesDir,
      candidateDir: target.candidateDir,
    });
    expect(report.reconstructed).toEqual(["v1"]);
    const restored = readActiveMasterSource(booted, target.paths.sourcesDir);
    expect(restored.ok).toBe(true);
  });

  it("reset preserves profiles, facts, and sources while clearing jobs", async () => {
    const { paths, candidateDir } = makeRoot();
    const handle = openDatabase({ path: paths.databasePath });
    handles.push(handle);
    handle.sqlite
      .prepare("INSERT INTO jobs (id, status, rank, row_version) VALUES ('job-1', 'NEW', 0, 1)")
      .run();
    const imported = importMasterDocument(handle, {
      document: pmFixture(),
      origin: "upload",
      sourcesDir: paths.sourcesDir,
    });
    if (!imported.ok) {
      throw new Error("import failed");
    }
    const result = await resetBoardData({
      handle,
      paths,
      candidateDir,
      stagingRoot: join(paths.root, "reset-staging"),
      openDatabaseAt: (dbPath: string) => openDatabase({ path: dbPath }),
      runMigrations: (fresh: DatabaseHandle) =>
        migrate(fresh.sqlite, { migrationsDir: resolveMigrationsDir() }),
      now: new Date("2026-09-12T10:00:00.000Z"),
    });
    expect(result.deletedJobs).toBe(1);
    expect(result.preservedProfile).toBe(true);
    handle.close();

    const reopened = openDatabase({ path: paths.databasePath });
    handles.push(reopened);
    const jobs = reopened.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number };
    expect(jobs.n).toBe(0);
    const sources = reopened.sqlite.prepare("SELECT COUNT(*) AS n FROM candidate_sources").get() as {
      n: number;
    };
    expect(sources.n).toBe(1);
    const facts = reopened.sqlite.prepare("SELECT COUNT(*) AS n FROM candidate_facts").get() as {
      n: number;
    };
    expect(facts.n).toBe(6);
    const restored = readActiveMasterSource(reopened, paths.sourcesDir);
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.bytes.toString("utf8")).toContain('"pm-fact-discovery"');
    }
  });
});
