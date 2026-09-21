// @vitest-environment node
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDatabase, migrate, type DatabaseHandle } from "../../../src/db";
import { resolveMigrationsDir } from "../../../src/db/testing";
import { backfillProfileSources } from "../../../src/server/sources";

/**
 * WO-1.2-B gate B4: a pre-0006 database upgrades with lineage intact,
 * active payloads authoritative, and the legacy file preserved as
 * evidence — never assigned to any profile. Legacy rows are seeded
 * with raw SQL because the current Drizzle schema lists columns the
 * old tables predate.
 */

function pmPayloadV1(): Record<string, unknown> {
  const fixture = JSON.parse(
    readFileSync(join(process.cwd(), "tests", "fixtures", "v1.2", "pm-profile.json"), "utf8"),
  ) as Record<string, unknown>;
  return { ...fixture, schemaVersion: "candidate-profile/v1" };
}

function spmPayloadV1(): Record<string, unknown> {
  const fixture = JSON.parse(
    readFileSync(join(process.cwd(), "tests", "fixtures", "v1.2", "spm-profile.json"), "utf8"),
  ) as Record<string, unknown>;
  return { ...fixture, schemaVersion: "candidate-profile/v1" };
}

interface LegacyDb {
  handle: DatabaseHandle;
  legacyDir: string;
  dbDir: string;
  candidateDir: string;
  sourcesDir: string;
}

function openLegacyDb(): LegacyDb {
  const realDir = resolveMigrationsDir();
  const legacyDir = mkdtempSync(join(tmpdir(), "job-tracker-b4-legacy-"));
  const dbDir = mkdtempSync(join(tmpdir(), "job-tracker-b4-db-"));
  for (const file of readdirSync(realDir)) {
    if (file.endsWith(".sql") && file < "0006_profile_sources.sql") {
      copyFileSync(join(realDir, file), join(legacyDir, file));
    }
  }
  const handle = ensureDatabase({ path: join(dbDir, "legacy.sqlite"), migrationsDir: legacyDir });
  const candidateDir = mkdtempSync(join(tmpdir(), "job-tracker-b4-candidate-"));
  const sourcesDir = mkdtempSync(join(tmpdir(), "job-tracker-b4-sources-"));
  return { handle, legacyDir, dbDir, candidateDir, sourcesDir };
}

function closeLegacyDb(legacy: LegacyDb): void {
  legacy.handle.close();
  rmSync(legacy.legacyDir, { recursive: true, force: true });
  rmSync(legacy.dbDir, { recursive: true, force: true });
  rmSync(legacy.candidateDir, { recursive: true, force: true });
  rmSync(legacy.sourcesDir, { recursive: true, force: true });
}

function seedLegacyProfiles(handle: DatabaseHandle): { pmVersionId: string; spmVersionId: string } {
  const sqlite = handle.sqlite;
  sqlite
    .prepare(
      "INSERT INTO candidate_profiles (id, name, display_name, is_default, work_preferences_json, executive_narrative) VALUES ('pm', 'pm', 'Product Manager', 1, NULL, 'PM narrative')",
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO candidate_profiles (id, name, display_name, is_default, work_preferences_json, executive_narrative) VALUES ('spm', 'spm', 'Senior Product Manager', 0, NULL, 'SPM narrative')",
    )
    .run();
  // A profile with no versions at all (empty-profile upgrade edge).
  sqlite.prepare("INSERT INTO candidate_profiles (id, name, display_name, is_default) VALUES ('empty', 'empty', 'Empty', 0)").run();
  const pmVersionId = "pm-version-1";
  const spmVersionId = "spm-version-1";
  sqlite
    .prepare(
      "INSERT INTO candidate_profile_versions (id, profile_id, version, payload_json, payload_hash, schema_version, activated_at) VALUES (?, 'pm', 1, ?, 'pm-hash', 'candidate-profile/v1', '2026-09-01T00:00:00.000Z')",
    )
    .run(pmVersionId, JSON.stringify(pmPayloadV1()));
  sqlite
    .prepare(
      "INSERT INTO candidate_profile_versions (id, profile_id, version, payload_json, payload_hash, schema_version, activated_at) VALUES (?, 'spm', 1, ?, 'spm-hash', 'candidate-profile/v1', '2026-09-01T00:00:00.000Z')",
    )
    .run(spmVersionId, JSON.stringify(spmPayloadV1()));
  sqlite
    .prepare(
      "INSERT INTO candidate_facts (fact_id, profile_version_id, kind, statement, verification, source) VALUES ('pm-fact-discovery', ?, 'discovery', 'Led customer discovery with 40+ B2B SaaS buyers that reshaped the roadmap and lifted trial-to-paid conversion by 18%.', 'APPROVED', 'launch report 2024')",
    )
    .run(pmVersionId);
  sqlite
    .prepare(
      "INSERT INTO candidate_facts (fact_id, profile_version_id, kind, statement, verification, source) VALUES ('spm-fact-platform', ?, 'strategy', 'Set multi-year platform strategy spanning three product lines and a 60-engineer organization.', 'APPROVED', 'strategy review 2025')",
    )
    .run(spmVersionId);
  return { pmVersionId, spmVersionId };
}

function tableDump(handle: DatabaseHandle, table: string): Array<Record<string, unknown>> {
  return handle.sqlite.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Array<
    Record<string, unknown>
  >;
}

describe("migration 0006 + source backfill (B4)", () => {
  it("upgrades a pre-0006 database with lineage intact and sources reconstructed", () => {
    const legacy = openLegacyDb();
    try {
      const { pmVersionId, spmVersionId } = seedLegacyProfiles(legacy.handle);
      // A legacy global file that DIVERGES from the stored payloads: it
      // must be preserved as evidence, never assigned to any profile.
      const legacyBytes = JSON.stringify({ schemaVersion: "candidate-import/v1", divergent: true });
      writeFileSync(join(legacy.candidateDir, "master-resume.json"), legacyBytes);
      const before = {
        profiles: tableDump(legacy.handle, "candidate_profiles"),
        versions: tableDump(legacy.handle, "candidate_profile_versions"),
        facts: tableDump(legacy.handle, "candidate_facts"),
      };

      const result = migrate(legacy.handle.sqlite, { migrationsDir: resolveMigrationsDir() });
      expect(result.applied).toEqual([
        "0006_profile_sources",
        "0007_generation_requests",
        "0008_tailoring_workspaces",
        "0009_step2_preparation",
        "0010_step2_publish_fence",
        "0011_step2_correction_versions",
      ]);
      const report = backfillProfileSources(legacy.handle, {
        sourcesDir: legacy.sourcesDir,
        candidateDir: legacy.candidateDir,
      });
      expect(report.reconstructed.sort()).toEqual([pmVersionId, spmVersionId].sort());
      expect(report.skipped).toEqual([]);
      expect(report.legacyPreserved).toBe(true);

      // Every pre-upgrade row is byte-identical (facts gain only the new
      // nullable provenance column, NULL everywhere).
      expect(tableDump(legacy.handle, "candidate_profiles")).toEqual(before.profiles);
      expect(tableDump(legacy.handle, "candidate_profile_versions")).toEqual(before.versions);
      expect(tableDump(legacy.handle, "candidate_facts")).toEqual(
        before.facts.map((row) => ({ ...row, provenance_json: null })),
      );

      // Each active version owns a reconstructed source labeled as such.
      const sources = tableDump(legacy.handle, "candidate_sources");
      expect(sources).toHaveLength(2);
      for (const row of sources) {
        expect(row["origin"]).toBe("reconstructed");
        const detail = JSON.parse(String(row["origin_detail_json"])) as Record<string, unknown>;
        expect(detail["kind"]).toBe("reconstructed");
        expect(detail["payloadSchemaVersion"]).toBe("candidate-profile/v1");
        const stored = JSON.parse(
          readFileSync(join(legacy.sourcesDir, String(row["relative_path"])), "utf8"),
        ) as Record<string, unknown>;
        expect(stored["schemaVersion"]).toBe("candidate-import/v2");
        expect(Array.isArray(stored["achievements"])).toBe(true);
      }
      const pmSource = sources.find((row) => row["profile_version_id"] === pmVersionId);
      const pmStored = JSON.parse(
        readFileSync(join(legacy.sourcesDir, String(pmSource?.["relative_path"])), "utf8"),
      ) as { achievements: Array<{ factId: string }> };
      expect(pmStored.achievements.map((entry) => entry.factId)).toContain("pm-fact-discovery");

      // The legacy file is preserved read-only as evidence, unassigned.
      expect(readFileSync(join(legacy.sourcesDir, "_legacy", "master-resume.json"), "utf8")).toBe(
        legacyBytes,
      );
      for (const row of sources) {
        expect(String(row["relative_path"])).not.toContain("_legacy");
      }

      // Idempotent: a second run reconstructs nothing and preserves nothing twice.
      const rerun = backfillProfileSources(legacy.handle, {
        sourcesDir: legacy.sourcesDir,
        candidateDir: legacy.candidateDir,
      });
      expect(rerun).toEqual({ reconstructed: [], skipped: [], legacyPreserved: false });
    } finally {
      closeLegacyDb(legacy);
    }
  });

  it("self-heals a version missing its source row without touching history", () => {
    const legacy = openLegacyDb();
    try {
      seedLegacyProfiles(legacy.handle);
      migrate(legacy.handle.sqlite, { migrationsDir: resolveMigrationsDir() });
      // A version committed without a source row (crashed publish path):
      // the backfill adopts its bytes instead of failing the boot.
      const before = tableDump(legacy.handle, "candidate_profile_versions");
      const report = backfillProfileSources(legacy.handle, {
        sourcesDir: legacy.sourcesDir,
        candidateDir: legacy.candidateDir,
      });
      expect(report.reconstructed).toHaveLength(2);
      expect(tableDump(legacy.handle, "candidate_profile_versions")).toEqual(before);
      const sources = tableDump(legacy.handle, "candidate_sources");
      expect(sources).toHaveLength(2);
      for (const row of sources) {
        const absolute = join(legacy.sourcesDir, String(row["relative_path"]));
        expect(readFileSync(absolute, "utf8").length).toBe(row["byte_size"]);
      }
    } finally {
      closeLegacyDb(legacy);
    }
  });

  it("skips unparseable payloads with a reason instead of failing the boot", () => {
    const legacy = openLegacyDb();
    try {
      seedLegacyProfiles(legacy.handle);
      legacy.handle.sqlite
        .prepare(
          "INSERT INTO candidate_profile_versions (id, profile_id, version, payload_json, payload_hash, schema_version, activated_at) VALUES ('bad-version', 'empty', 1, '{}', 'bad-hash', 'candidate-profile/v1', '2026-09-01T00:00:00.000Z')",
        )
        .run();
      migrate(legacy.handle.sqlite, { migrationsDir: resolveMigrationsDir() });
      const report = backfillProfileSources(legacy.handle, {
        sourcesDir: legacy.sourcesDir,
        candidateDir: legacy.candidateDir,
      });
      expect(report.reconstructed).toHaveLength(2);
      expect(report.skipped).toEqual([
        { profileVersionId: "bad-version", reason: "stored payload is not a valid profile document" },
      ]);
    } finally {
      closeLegacyDb(legacy);
    }
  });
});
