// @vitest-environment node
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../src/db";
import {
  getActiveProfileVersion,
  getFact,
  getProfile,
  getProfileVersion,
  listFactsByVersion,
} from "../../../src/db/candidates";
import { FactProvenanceV1 } from "../../../src/domain/candidate";
import {
  activateProfileVersion,
  copyProfileFromVersion,
  importCandidate,
} from "../../../src/server/candidates";

/**
 * WO-1.2-B gate B6: Create from existing profile copies an immutable
 * source version into an independent inactive draft — minted fact ids
 * with recorded provenance, verification retained exactly, preferences
 * copied by value, explicit activation required. Resumes, approvals,
 * and applications are never touched.
 */

function pmFixture(): unknown {
  return JSON.parse(
    readFileSync(join(process.cwd(), "tests", "fixtures", "v1.2", "pm-profile.json"), "utf8"),
  ) as unknown;
}

function withSources(fn: (t: TestDatabase, sourcesDir: string) => void): void {
  const t = createTestDatabase("job-tracker-b6-copy-");
  const sourcesDir = mkdtempSync(join(tmpdir(), "job-tracker-b6-sources-"));
  try {
    fn(t, sourcesDir);
  } finally {
    t.cleanup();
    rmSync(sourcesDir, { recursive: true, force: true });
  }
}

function importPm(t: TestDatabase): { versionId: string } {
  const imported = importCandidate(t.handle, { document: pmFixture(), actor: "human" });
  if (!imported.ok) {
    throw new Error(`pm import failed: ${imported.error}`);
  }
  const activated = activateProfileVersion(t.handle, { versionId: imported.versionId, actor: "human" });
  if (!activated.ok) {
    throw new Error("pm activation failed");
  }
  return { versionId: imported.versionId };
}

describe("copyProfileFromVersion (B6)", () => {
  it("copies content with minted ids, retained verification, and recorded lineage", () => {
    withSources((t, sourcesDir) => {
      const source = importPm(t);
      const sourceProfile = getProfile(t.handle, "default");
      if (sourceProfile === null) {
        throw new Error("default profile missing");
      }
      const result = copyProfileFromVersion(
        t.handle,
        {
          sourceProfileId: sourceProfile.id,
          name: "spm-copy",
          displayName: "Senior PM (copy)",
          actor: "human",
        },
        { sourcesDir },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.version).toBe(1);
      expect(result.copiedFacts).toBe(6);
      expect(result.factIdMap).toHaveLength(6);

      // Minted ids, provenance recorded, verification retained exactly.
      const targetFacts = listFactsByVersion(t.handle, result.versionId);
      expect(targetFacts).toHaveLength(6);
      for (const entry of result.factIdMap) {
        expect(entry.from).not.toBe(entry.to);
        const copied = getFact(t.handle, entry.to);
        const original = getFact(t.handle, entry.from);
        expect(copied?.statement).toBe(original?.statement);
        expect(copied?.verification).toBe(original?.verification);
        const provenance = FactProvenanceV1.parse(JSON.parse(copied?.provenanceJson ?? ""));
        expect(provenance.origin).toBe("copy");
        expect(provenance.originProfileId).toBe(sourceProfile.id);
        expect(provenance.originVersionId).toBe(source.versionId);
        expect(provenance.originFactId).toBe(entry.from);
      }

      // Preferences and narrative copied by value; never the default.
      const target = getProfile(t.handle, result.profileId);
      expect(target?.isDefault).toBe(false);
      expect(getProfile(t.handle, sourceProfile.id)?.isDefault).toBe(true);

      // Inactive draft: explicit activation is still required.
      expect(getActiveProfileVersion(t.handle, result.profileId)).toBeNull();
      const activated = activateProfileVersion(t.handle, { versionId: result.versionId, actor: "human" });
      expect(activated.ok).toBe(true);

      // Nothing outside the candidate area was created.
      const counts = t.handle.sqlite
        .prepare(
          "SELECT (SELECT COUNT(*) FROM resume_versions) AS versions, (SELECT COUNT(*) FROM resume_reviews) AS reviews, (SELECT COUNT(*) FROM applications) AS applications",
        )
        .get() as { versions: number; reviews: number; applications: number };
      expect(counts).toEqual({ versions: 0, reviews: 0, applications: 0 });
    });
  });

  it("keeps copies independent after edits on either side", () => {
    withSources((t, sourcesDir) => {
      importPm(t);
      const sourceProfile = getProfile(t.handle, "default");
      if (sourceProfile === null) {
        throw new Error("default profile missing");
      }
      const copied = copyProfileFromVersion(
        t.handle,
        { sourceProfileId: sourceProfile.id, name: "spm-copy", displayName: "Copy", actor: "human" },
        { sourcesDir },
      );
      if (!copied.ok) {
        throw new Error("copy failed");
      }
      const targetProfile = getProfile(t.handle, copied.profileId);
      if (targetProfile === null) {
        throw new Error("copy profile missing");
      }
      const before = listFactsByVersion(t.handle, copied.versionId).map((fact) => fact.statement);

      // Edit the source: same content shape, one new fact id.
      const editedSource = pmFixture() as Record<string, unknown>;
      const achievements = editedSource["achievements"] as Array<Record<string, unknown>>;
      const second = importCandidate(t.handle, {
        document: {
          ...editedSource,
          achievements: [
            ...achievements,
            {
              factId: "pm-fact-brand-new",
              employmentId: "emp-harbor",
              category: "delivery",
              text: "A brand new source-only achievement.",
              technologies: [],
              metrics: [],
              verification: "APPROVED",
            },
          ],
        },
        actor: "human",
        profileId: sourceProfile.id,
      });
      expect(second.ok).toBe(true);
      expect(listFactsByVersion(t.handle, copied.versionId).map((fact) => fact.statement)).toEqual(
        before,
      );

      // Edit the copy: the source is untouched.
      const copyDoc = {
        ...(pmFixture() as Record<string, unknown>),
        achievements: [
          {
            factId: "copy-only-fact",
            employmentId: "emp-harbor",
            category: "delivery",
            text: "A copy-only achievement.",
            technologies: [],
            metrics: [],
            verification: "PENDING",
          },
        ],
      };
      const copySecond = importCandidate(t.handle, {
        document: copyDoc,
        actor: "human",
        profileId: targetProfile.id,
      });
      expect(copySecond.ok).toBe(true);
      const copyOnly = getFact(t.handle, "copy-only-fact");
      expect(copyOnly).not.toBeNull();
      expect(getProfileVersion(t.handle, copyOnly?.profileVersionId ?? "")?.profileId).toBe(
        targetProfile.id,
      );
      expect(listFactsByVersion(t.handle, copied.versionId)).toHaveLength(6);
    });
  });

  it("never upgrades unapproved source facts through copying", () => {
    withSources((t, sourcesDir) => {
      const doc = {
        ...(pmFixture() as Record<string, unknown>),
        achievements: [
          {
            factId: "pending-fact",
            employmentId: "emp-harbor",
            category: "delivery",
            text: "An unverified claim.",
            technologies: [],
            metrics: [],
            verification: "PENDING",
          },
        ],
      };
      const imported = importCandidate(t.handle, { document: doc, actor: "human" });
      if (!imported.ok) {
        throw new Error("import failed");
      }
      activateProfileVersion(t.handle, { versionId: imported.versionId, actor: "human" });
      const sourceProfile = getProfile(t.handle, "default");
      if (sourceProfile === null) {
        throw new Error("default profile missing");
      }
      const copied = copyProfileFromVersion(
        t.handle,
        { sourceProfileId: sourceProfile.id, name: "copy", displayName: "Copy", actor: "human" },
        { sourcesDir },
      );
      expect(copied.ok).toBe(true);
      if (!copied.ok) {
        return;
      }
      const targetFacts = listFactsByVersion(t.handle, copied.versionId);
      expect(targetFacts).toHaveLength(1);
      expect(targetFacts[0]?.verification).toBe("PENDING");
    });
  });

  it("fails closed on unknown, ambiguous, taken, and corrupt inputs", () => {
    withSources((t, sourcesDir) => {
      const { versionId } = importPm(t);
      const sourceProfile = getProfile(t.handle, "default");
      if (sourceProfile === null) {
        throw new Error("default profile missing");
      }
      expect(
        copyProfileFromVersion(
          t.handle,
          { sourceProfileId: "no-such-profile", name: "x", displayName: "X", actor: "human" },
          { sourcesDir },
        ),
      ).toMatchObject({ ok: false, error: "profile-not-found" });
      expect(
        copyProfileFromVersion(
          t.handle,
          {
            sourceProfileId: sourceProfile.id,
            sourceVersionId: "00000000-0000-4000-8000-000000000000",
            name: "x",
            displayName: "X",
            actor: "human",
          },
          { sourcesDir },
        ),
      ).toMatchObject({ ok: false, error: "version-not-found" });
      const first = copyProfileFromVersion(
        t.handle,
        { sourceProfileId: sourceProfile.id, name: "taken", displayName: "Taken", actor: "human" },
        { sourcesDir },
      );
      expect(first.ok).toBe(true);
      expect(
        copyProfileFromVersion(
          t.handle,
          { sourceProfileId: sourceProfile.id, name: "taken", displayName: "Taken", actor: "human" },
          { sourcesDir },
        ),
      ).toMatchObject({ ok: false, error: "name-taken" });

      // A profile with no active version cannot be a copy source.
      const emptyVersions = t.handle.sqlite
        .prepare("SELECT COUNT(*) AS n FROM candidate_profile_versions WHERE profile_id = ?")
        .get((first.ok ? first.profileId : "missing") as string) as { n: number };
      expect(emptyVersions.n).toBe(1);
      const inactiveProfile = first.ok ? first.profileId : "missing";
      expect(
        copyProfileFromVersion(
          t.handle,
          { sourceProfileId: inactiveProfile, name: "x2", displayName: "X2", actor: "human" },
          { sourcesDir },
        ),
      ).toMatchObject({ ok: false, error: "source-has-no-active-version" });

      // A version from another profile is not a valid explicit source.
      expect(
        copyProfileFromVersion(
          t.handle,
          {
            sourceProfileId: inactiveProfile,
            sourceVersionId: versionId,
            name: "x3",
            displayName: "X3",
            actor: "human",
          },
          { sourcesDir },
        ),
      ).toMatchObject({ ok: false, error: "version-profile-mismatch" });
    });
  });
});
