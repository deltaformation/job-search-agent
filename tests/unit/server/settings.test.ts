// @vitest-environment node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../../src/db/testing";
import type { DataRootPaths } from "../../../src/security/data-root";
import {
  getSettingsSnapshot,
  masterResumePath,
  pingOpenRouter,
  resyncMasterResume,
  switchModels,
} from "../../../src/server/settings";

function fixtureDocument(): unknown {
  const path = join(process.cwd(), "tests", "fixtures", "candidate", "master-resume.v1.json");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function withDatabase(fn: (t: ReturnType<typeof createTestDatabase>) => void): void {
  const t = createTestDatabase("job-tracker-settings-test-");
  try {
    fn(t);
  } finally {
    t.cleanup();
  }
}

function pathsFor(t: ReturnType<typeof createTestDatabase>): DataRootPaths {
  const evidenceDir = join(t.dir, "evidence");
  const artifactsDir = join(t.dir, "artifacts");
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  return { root: t.dir, databasePath: t.dbPath, evidenceDir, artifactsDir };
}

describe("getSettingsSnapshot", () => {
  it("reports models, key status, profile, and storage without the secret", () => {
    withDatabase((t) => {
      t.handle.sqlite
        .prepare("INSERT INTO jobs (id, status, rank, row_version) VALUES ('job-1', 'NEW', 0, 1)")
        .run();
      const paths = pathsFor(t);
      writeFileSync(join(t.dir, "evidence", "page"), "<html>e</html>");
      const snapshot = getSettingsSnapshot(t.handle, {
        paths,
        env: {
          OPENROUTER_MODEL: "model-a",
          OPENROUTER_FALLBACK_MODEL: "model-b",
          OPENROUTER_API_KEY: "sk-test-secret",
        },
      });
      expect(snapshot.models).toEqual({ primary: "model-a", fallback: "model-b" });
      expect(snapshot.openRouter.configured).toBe(true);
      expect(snapshot.openRouter.fingerprint).toMatch(/^[0-9a-f]{8}$/);
      expect(JSON.stringify(snapshot)).not.toContain("sk-test-secret");
      expect(snapshot.profile).toBeNull();
      expect(snapshot.storage.jobCount).toBe(1);
      expect(snapshot.storage.evidenceFiles).toBe(1);
      expect(snapshot.storage.databaseBytes).toBeGreaterThan(0);
    });
  });

  it("falls back to default models and reports an unconfigured key", () => {
    withDatabase((t) => {
      const snapshot = getSettingsSnapshot(t.handle, { paths: pathsFor(t), env: {} });
      expect(snapshot.models).toEqual({
        primary: "google/gemma-4-26b-a4b-it:free",
        fallback: "nvidia/nemotron-3.5-lightning:free",
      });
      expect(snapshot.openRouter).toEqual({ configured: false, fingerprint: null });
    });
  });
});

describe("switchModels", () => {
  it("upserts the model chain while preserving other env lines", () => {
    withDatabase((t) => {
      const envFile = join(t.dir, ".env.local");
      writeFileSync(envFile, "# comment\nOPENROUTER_API_KEY=sk-keep\nOPENROUTER_MODEL=old-model\n");
      const result = switchModels(envFile, { primary: "new-model", fallback: "fb-model" });
      expect(result).toEqual({
        primary: "new-model",
        fallback: "fb-model",
        restartRequired: true,
      });
      const content = readFileSync(envFile, "utf8");
      expect(content).toContain("# comment");
      expect(content).toContain("OPENROUTER_API_KEY=sk-keep");
      expect(content).toContain("OPENROUTER_MODEL=new-model");
      expect(content).toContain("OPENROUTER_FALLBACK_MODEL=fb-model");
      expect(content).not.toContain("old-model");
    });
  });

  it("clears an explicit fallback line", () => {
    withDatabase((t) => {
      const envFile = join(t.dir, "nested", ".env.local");
      mkdirSync(join(t.dir, "nested"), { recursive: true });
      writeFileSync(envFile, "OPENROUTER_MODEL=model-a\nOPENROUTER_FALLBACK_MODEL=fb-old\n");
      const result = switchModels(envFile, { clearFallback: true });
      expect(result.restartRequired).toBe(true);
      expect(result.primary).toBe("model-a");
      // No explicit fallback left, so the chain falls back to the default.
      expect(result.fallback).toBe("nvidia/nemotron-3.5-lightning:free");
      const content = readFileSync(envFile, "utf8");
      expect(content).toContain("# OPENROUTER_FALLBACK_MODEL removed by Settings");
      expect(content).not.toContain("fb-old\n");
    });
  });

  it("rejects an empty switch and a hostile model id", () => {
    withDatabase((t) => {
      const envFile = join(t.dir, ".env.local");
      expect(() => switchModels(envFile, {})).toThrow("nothing to switch");
      expect(() => switchModels(envFile, { primary: "x; rm -rf /" })).toThrow();
    });
  });
});

describe("pingOpenRouter", () => {
  it("reports unconfigured without touching the network", async () => {
    const result = await pingOpenRouter({});
    expect(result).toEqual({
      ok: false,
      model: null,
      latencyMs: 0,
      error: "OPENROUTER_API_KEY is not configured",
    });
  });
});

describe("resyncMasterResume", () => {
  it("imports and activates the master resume, then no-ops when current", () => {
    withDatabase((t) => {
      const candidateDir = join(t.dir, "candidate");
      mkdirSync(candidateDir, { recursive: true });
      const master = masterResumePath(candidateDir);
      writeFileSync(master, JSON.stringify(fixtureDocument()));
      const first = resyncMasterResume(t.handle, master);
      expect(first.ok).toBe(true);
      if (!first.ok) {
        return;
      }
      expect(first.activated).toBe(true);
      expect(first.alreadyCurrent).toBe(false);
      const second = resyncMasterResume(t.handle, master);
      expect(second).toMatchObject({ ok: true, alreadyCurrent: true, versionId: first.versionId });
      const versions = t.handle.sqlite
        .prepare("SELECT COUNT(*) AS count FROM candidate_profile_versions")
        .get() as { count: number };
      expect(versions.count).toBe(1);
    });
  });

  it("imports edited content as a new version and activates it", () => {
    withDatabase((t) => {
      const candidateDir = join(t.dir, "candidate");
      mkdirSync(candidateDir, { recursive: true });
      const master = masterResumePath(candidateDir);
      const document = fixtureDocument() as Record<string, unknown>;
      writeFileSync(master, JSON.stringify(document));
      const first = resyncMasterResume(t.handle, master);
      expect(first.ok).toBe(true);
      // Edited content hashes differently from the latest version, so
      // resync imports it as a new version and activates it.
      const edited = { ...document, summary: "Edited summary for version two" };
      writeFileSync(master, JSON.stringify(edited));
      const second = resyncMasterResume(t.handle, master);
      expect(second.ok).toBe(true);
      if (!second.ok) {
        return;
      }
      expect(second.alreadyCurrent).toBe(false);
    });
  });

  it("reports missing and invalid master files without touching versions", () => {
    withDatabase((t) => {
      const missing = resyncMasterResume(t.handle, join(t.dir, "nope", "master-resume.json"));
      expect(missing).toMatchObject({ ok: false, error: "master-resume-missing" });
      const badPath = join(t.dir, "bad.json");
      writeFileSync(badPath, "{not json");
      expect(resyncMasterResume(t.handle, badPath)).toMatchObject({
        ok: false,
        error: "master-resume-invalid",
      });
      const versions = t.handle.sqlite
        .prepare("SELECT COUNT(*) AS count FROM candidate_profile_versions")
        .get() as { count: number };
      expect(versions.count).toBe(0);
    });
  });
});
