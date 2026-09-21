// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../src/db";
import { createProfile, setDefaultProfile } from "../../../src/db/candidates";
import {
  activateProfileVersion,
  importCandidate,
} from "../../../src/server/candidates";
import { resolveMasterPreview } from "../../../src/server/masterPreview";

/**
 * Pinned master preview resolution (WO-1.2-F, F2): explicit
 * profile/version identity survives later default switches and master
 * updates; unknown identity is an honest error, never a silent
 * fallback to another profile.
 */

function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(process.cwd(), "tests", "fixtures", "v1.2", name), "utf8"),
  ) as unknown;
}

function runWithDatabase(fn: (t: TestDatabase) => void): void {
  const t = createTestDatabase("job-tracker-master-preview-test-");
  try {
    fn(t);
  } finally {
    t.cleanup();
  }
}

function importAndActivate(
  t: TestDatabase,
  profileId: string,
  fixture: string,
): string {
  const imported = importCandidate(t.handle, {
    document: loadFixture(fixture),
    actor: "human",
    profileId,
  });
  if (!imported.ok) {
    throw new Error(`import failed: ${JSON.stringify(imported)}`);
  }
  const activated = activateProfileVersion(t.handle, {
    versionId: imported.versionId,
    actor: "human",
  });
  if (!activated.ok) {
    throw new Error(`activate failed: ${JSON.stringify(activated)}`);
  }
  return imported.versionId;
}

describe("resolveMasterPreview", () => {
  it("resolves the default profile's active version when identity is omitted", () => {
    runWithDatabase((t) => {
      const pm = createProfile(t.handle, { name: "pm", displayName: "Product Manager" });
      importAndActivate(t, pm.id, "pm-profile.json");
      const result = resolveMasterPreview(t.handle, {});
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.profileId).toBe(pm.id);
      expect(result.profileDisplayName).toBe("Product Manager");
      expect(result.version).toBe(1);
      expect(result.payload.identity.fullName).not.toBe("");
    });
  });

  it("keeps explicit identity pinned across default switches and master updates", () => {
    runWithDatabase((t) => {
      const pm = createProfile(t.handle, { name: "pm", displayName: "Product Manager" });
      const spm = createProfile(t.handle, { name: "spm", displayName: "Senior Product Manager" });
      importAndActivate(t, pm.id, "pm-profile.json");
      importAndActivate(t, spm.id, "spm-profile.json");
      // A second PM master supersedes v1 as the active version, and
      // the default moves to the SPM profile.
      importAndActivate(t, pm.id, "pm-profile.json");
      expect(setDefaultProfile(t.handle, spm.id)).toBe(true);

      const pinned = resolveMasterPreview(t.handle, { profileId: pm.id, version: 1 });
      expect(pinned.ok).toBe(true);
      if (!pinned.ok) {
        return;
      }
      expect(pinned.profileId).toBe(pm.id);
      expect(pinned.version).toBe(1);

      const current = resolveMasterPreview(t.handle, {});
      expect(current.ok).toBe(true);
      if (!current.ok) {
        return;
      }
      expect(current.profileId).toBe(spm.id);

      const active = resolveMasterPreview(t.handle, { profileId: pm.id });
      expect(active.ok).toBe(true);
      if (!active.ok) {
        return;
      }
      expect(active.version).toBe(2);
    });
  });

  it("rejects unknown identity without falling back to another profile", () => {
    runWithDatabase((t) => {
      const pm = createProfile(t.handle, { name: "pm", displayName: "Product Manager" });
      importAndActivate(t, pm.id, "pm-profile.json");

      const unknownProfile = resolveMasterPreview(t.handle, { profileId: "nope" });
      expect(unknownProfile).toMatchObject({ ok: false, error: "unknown-profile" });

      const unknownVersion = resolveMasterPreview(t.handle, { profileId: pm.id, version: 9 });
      expect(unknownVersion).toMatchObject({ ok: false, error: "unknown-version" });
    });
  });

  it("reports missing masters honestly", () => {
    runWithDatabase((t) => {
      expect(resolveMasterPreview(t.handle, {})).toMatchObject({ ok: false, error: "no-profiles" });
      const bare = createProfile(t.handle, { name: "bare", displayName: "Bare" });
      expect(resolveMasterPreview(t.handle, {})).toMatchObject({
        ok: false,
        error: "no-active-version",
      });
      expect(resolveMasterPreview(t.handle, { profileId: bare.id })).toMatchObject({
        ok: false,
        error: "no-active-version",
      });
    });
  });
});
