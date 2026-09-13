// @vitest-environment node
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createTestDatabase,
  ensureDatabase,
  migrate,
  newId,
  resolveMigrationsDir,
  utcNow,
  type TestDatabase,
} from "../../../src/db";
import {
  activateProfileVersion,
  createProfile,
  ensureLocalProfile,
  getActiveProfileVersion,
  getDefaultProfile,
  getProfile,
  getProfileVersionByNumber,
  insertCandidateSnapshot,
  insertFact,
  insertProfileVersion,
  insertSnapshotFactMembership,
  listFactsByVersion,
  listProfiles,
  listProfileVersions,
  listSnapshotFacts,
  nextProfileVersionNumber,
  setDefaultProfile,
  setFactVerification,
  updateProfile,
  LOCAL_PROFILE_ID,
} from "../../../src/db/candidates";
import {
  candidateFacts,
  candidateProfileVersions,
  candidateProfiles,
} from "../../../src/db/schema";

function withDatabase(fn: (t: TestDatabase) => void): void {
  const t = createTestDatabase("job-tracker-multi-profile-");
  try {
    fn(t);
  } finally {
    t.cleanup();
  }
}

function seedVersion(
  t: TestDatabase,
  profileId: string,
  version: number,
): string {
  const row = insertProfileVersion(t.handle, {
    profileId,
    version,
    payloadJson: "{}",
    payloadHash: `${profileId}-hash-${version}`,
    schemaVersion: "profile-v1",
  });
  return row.id;
}

describe("multi-profile candidate repository (R-ADR-012)", () => {
  it("migrates a pre-0005 database with lineage intact and triggers live", () => {
    const realDir = resolveMigrationsDir();
    const legacyDir = mkdtempSync(join(tmpdir(), "job-tracker-migrate-legacy-"));
    const dbDir = mkdtempSync(join(tmpdir(), "job-tracker-migrate-db-"));
    try {
      for (const file of readdirSync(realDir)) {
        if (file.endsWith(".sql") && file < "0005_multi_candidate_profiles.sql") {
          copyFileSync(join(realDir, file), join(legacyDir, file));
        }
      }
      const handle = ensureDatabase({
        path: join(dbDir, "legacy.sqlite"),
        migrationsDir: legacyDir,
      });
      try {
        // Old shape: bare root row plus a version with an approved fact.
        handle.sqlite
          .prepare("INSERT INTO candidate_profiles (id, created_at) VALUES ('local', '2026-09-11T12:00:00.000Z')")
          .run();
        const versionId = newId();
        handle.db
          .insert(candidateProfileVersions)
          .values({
            id: versionId,
            profileId: "local",
            version: 1,
            payloadJson: "{}",
            payloadHash: "h",
            schemaVersion: "profile-v1",
            activatedAt: "2026-09-11T12:00:00.000Z",
          })
          .run();
        handle.db
          .insert(candidateFacts)
          .values({
            factId: "fact-1",
            profileVersionId: versionId,
            kind: "achievement",
            statement: "Shipped it",
            verification: "APPROVED",
          })
          .run();

        const result = migrate(handle.sqlite, { migrationsDir: realDir });
        expect(result.applied).toEqual(["0005_multi_candidate_profiles"]);
        expect(result.alreadyApplied).toHaveLength(5);

        const backfilled = getProfile(handle, "local");
        expect(backfilled).toMatchObject({
          id: "local",
          name: "default",
          displayName: "Primary Profile",
          isDefault: true,
          workPreferences: null,
          executiveNarrative: null,
        });
        expect(getDefaultProfile(handle)?.id).toBe("local");
        // Lineage survived the rebuild.
        expect(listProfileVersions(handle, "local")).toHaveLength(1);
        expect(listFactsByVersion(handle, versionId)).toHaveLength(1);
        expect(getActiveProfileVersion(handle, "local")?.id).toBe(versionId);
        // Version/fact immutability still enforced after the rebuild.
        expect(() =>
          handle.db
            .update(candidateProfileVersions)
            .set({ payloadJson: `{"x":1}` })
            .where(eq(candidateProfileVersions.id, versionId))
            .run(),
        ).toThrow(/immutable/);
        expect(() =>
          handle.db
            .update(candidateFacts)
            .set({ statement: "Rewritten" })
            .where(eq(candidateFacts.factId, "fact-1"))
            .run(),
        ).toThrow(/immutable/);
        // And a second profile can now be created on the upgraded database.
        const second = createProfile(handle, { name: "staff", displayName: "Staff" });
        expect(second.isDefault).toBe(false);
      } finally {
        handle.close();
      }
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("creates multiple profiles with first-profile defaulting", () => {
    withDatabase((t) => {
      expect(listProfiles(t.handle)).toEqual([]);
      const first = createProfile(t.handle, {
        name: "staff-engineer",
        displayName: "Staff Engineer",
        workPreferences: { workMode: ["REMOTE"], yearsOfExperience: 9 },
        executiveNarrative: "Platform leader.",
      });
      expect(first.isDefault).toBe(true);
      expect(first.workPreferences).toMatchObject({
        schemaVersion: "work-preferences/v1",
        workMode: ["REMOTE"],
        yearsOfExperience: 9,
        sponsorshipRequired: false,
      });
      const second = createProfile(t.handle, { name: "eng-manager", displayName: "EM" });
      expect(second.isDefault).toBe(false);
      expect(second.workPreferences).toBeNull();
      expect(listProfiles(t.handle).map((profile) => profile.name)).toEqual([
        "eng-manager",
        "staff-engineer",
      ]);
      expect(getProfile(t.handle, first.id)?.name).toBe("staff-engineer");
      expect(getProfile(t.handle, "eng-manager")?.id).toBe(second.id);
      expect(getProfile(t.handle, "nope")).toBeNull();
      expect(getDefaultProfile(t.handle)?.id).toBe(first.id);
    });
  });

  it("switches the default and rejects duplicates at the database", () => {
    withDatabase((t) => {
      const first = createProfile(t.handle, { name: "a", displayName: "A" });
      const second = createProfile(t.handle, { name: "b", displayName: "B" });
      expect(setDefaultProfile(t.handle, "unknown")).toBe(false);
      expect(setDefaultProfile(t.handle, second.id)).toBe(true);
      expect(getDefaultProfile(t.handle)?.id).toBe(second.id);
      expect(getProfile(t.handle, first.id)?.isDefault).toBe(false);
      expect(() =>
        createProfile(t.handle, { name: "a", displayName: "Dup" }),
      ).toThrow(/UNIQUE constraint failed/i);
      expect(() =>
        t.handle.db
          .insert(candidateProfiles)
          .values({ id: newId(), name: "c", displayName: "C", isDefault: true })
          .run(),
      ).toThrow(/UNIQUE constraint failed/i);
      // Explicit default creation steals the marker atomically per statement.
      const third = createProfile(t.handle, { name: "c", displayName: "C", isDefault: true });
      expect(getDefaultProfile(t.handle)?.id).toBe(third.id);
      expect(getProfile(t.handle, second.id)?.isDefault).toBe(false);
    });
  });

  it("versions, numbers, and activation stay scoped per profile", () => {
    withDatabase((t) => {
      const a = createProfile(t.handle, { name: "a", displayName: "A" });
      const b = createProfile(t.handle, { name: "b", displayName: "B" });
      expect(nextProfileVersionNumber(t.handle, a.id)).toBe(1);
      const a1 = seedVersion(t, a.id, 1);
      const a2 = seedVersion(t, a.id, 2);
      const b1 = seedVersion(t, b.id, 1);
      expect(nextProfileVersionNumber(t.handle, a.id)).toBe(3);
      expect(nextProfileVersionNumber(t.handle, b.id)).toBe(2);
      expect(listProfileVersions(t.handle, a.id).map((row) => row.version)).toEqual([1, 2]);
      expect(listProfileVersions(t.handle, b.id).map((row) => row.version)).toEqual([1]);
      expect(getProfileVersionByNumber(t.handle, 1, b.id)?.id).toBe(b1);
      // Omitted profileId resolves to the default profile (a).
      expect(listProfileVersions(t.handle).map((row) => row.id)).toEqual([a1, a2]);
      // Each profile holds its own active version; activating on one side
      // never disturbs the other.
      expect(activateProfileVersion(t.handle, a2, utcNow())).toBe(true);
      expect(activateProfileVersion(t.handle, b1, utcNow())).toBe(true);
      expect(getActiveProfileVersion(t.handle, a.id)?.id).toBe(a2);
      expect(getActiveProfileVersion(t.handle, b.id)?.id).toBe(b1);
      expect(activateProfileVersion(t.handle, a1, utcNow())).toBe(true);
      expect(getActiveProfileVersion(t.handle, a.id)?.id).toBe(a1);
      expect(getActiveProfileVersion(t.handle, b.id)?.id).toBe(b1);
      expect(activateProfileVersion(t.handle, newId(), utcNow())).toBe(false);
    });
  });

  it("binds facts and snapshots to per-profile versions", () => {
    withDatabase((t) => {
      const a = createProfile(t.handle, { name: "a", displayName: "A" });
      const b = createProfile(t.handle, { name: "b", displayName: "B" });
      const a1 = seedVersion(t, a.id, 1);
      const b1 = seedVersion(t, b.id, 1);
      insertFact(t.handle, {
        factId: "fact-a",
        profileVersionId: a1,
        kind: "achievement",
        statement: "A shipped",
        evidenceJson: null,
        verification: "APPROVED",
        source: null,
      });
      insertFact(t.handle, {
        factId: "fact-b",
        profileVersionId: b1,
        kind: "achievement",
        statement: "B shipped",
        evidenceJson: null,
        verification: "APPROVED",
        source: null,
      });
      expect(listFactsByVersion(t.handle, a1).map((fact) => fact.factId)).toEqual(["fact-a"]);
      const snapshot = insertCandidateSnapshot(t.handle, {
        profileVersionId: b1,
        canonicalJson: "{}",
        schemaVersion: "candidate-snapshot-v1",
        sha256: "s".repeat(64),
      });
      insertSnapshotFactMembership(t.handle, snapshot.id, "fact-b");
      expect(listSnapshotFacts(t.handle, snapshot.id).map((fact) => fact.factId)).toEqual([
        "fact-b",
      ]);
      // Review transitions still work per version.
      insertFact(t.handle, {
        factId: "fact-draft",
        profileVersionId: a1,
        kind: "achievement",
        statement: "draft",
        evidenceJson: null,
        verification: "PENDING",
        source: null,
      });
      expect(setFactVerification(t.handle, "fact-draft", "APPROVED")).toBe(true);
      expect(setFactVerification(t.handle, "fact-draft", "REJECTED")).toBe(false);
    });
  });

  it("freezes profile identity while allowing metadata updates", () => {
    withDatabase((t) => {
      const profile = createProfile(t.handle, { name: "a", displayName: "A" });
      const updated = updateProfile(
        t.handle,
        profile.id,
        {
          displayName: "Staff Engineer",
          workPreferences: { workMode: ["HYBRID"], willingToRelocate: true },
          executiveNarrative: "Leads teams.",
        },
        "2026-09-13T00:00:01.000Z",
      );
      expect(updated).toMatchObject({
        displayName: "Staff Engineer",
        executiveNarrative: "Leads teams.",
        updatedAt: "2026-09-13T00:00:01.000Z",
      });
      expect(updated?.workPreferences).toMatchObject({
        workMode: ["HYBRID"],
        willingToRelocate: true,
      });
      const cleared = updateProfile(
        t.handle,
        profile.id,
        { workPreferences: null, executiveNarrative: null },
        "2026-09-13T00:00:02.000Z",
      );
      expect(cleared?.workPreferences).toBeNull();
      expect(cleared?.executiveNarrative).toBeNull();
      expect(updateProfile(t.handle, newId(), { displayName: "X" }, utcNow())).toBeNull();
      expect(() =>
        t.handle.db
          .update(candidateProfiles)
          .set({ name: "renamed" })
          .where(eq(candidateProfiles.id, profile.id))
          .run(),
      ).toThrow(/immutable/);
      expect(() =>
        t.handle.db.delete(candidateProfiles).where(eq(candidateProfiles.id, profile.id)).run(),
      ).toThrow(/cannot be deleted/);
    });
  });

  it("rejects invalid profile input without writing", () => {
    withDatabase((t) => {
      expect(() => createProfile(t.handle, { name: "Bad Name!", displayName: "X" })).toThrow();
      expect(() =>
        createProfile(t.handle, {
          name: "ok",
          displayName: "X",
          workPreferences: { workMode: ["TELEPORT" as unknown as "REMOTE"] },
        }),
      ).toThrow();
      expect(listProfiles(t.handle)).toEqual([]);
      const profile = createProfile(t.handle, { name: "ok", displayName: "X" });
      expect(() =>
        updateProfile(t.handle, profile.id, { displayName: "   " }, utcNow()),
      ).toThrow();
      expect(getProfile(t.handle, profile.id)?.displayName).toBe("X");
    });
  });

  it("keeps ensureLocalProfile idempotent for legacy flows", () => {
    withDatabase((t) => {
      expect(ensureLocalProfile(t.handle)).toBe(LOCAL_PROFILE_ID);
      expect(ensureLocalProfile(t.handle)).toBe(LOCAL_PROFILE_ID);
      expect(getProfile(t.handle, LOCAL_PROFILE_ID)).toMatchObject({
        name: "default",
        displayName: "Primary Profile",
        isDefault: true,
      });
      expect(listProfiles(t.handle)).toHaveLength(1);
    });
  });
});
