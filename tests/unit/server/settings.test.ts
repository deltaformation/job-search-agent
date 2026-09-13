// @vitest-environment node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../src/db/testing";
import type { DataRootPaths } from "../../../src/security/data-root";
import {
  getSettingsSnapshot,
  masterResumePath,
  pingOpenRouter,
  pingProvider,
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

  it("reports the active provider plus per-provider chains and key status", () => {
    withDatabase((t) => {
      const snapshot = getSettingsSnapshot(t.handle, {
        paths: pathsFor(t),
        env: {
          ACTIVE_AI_PROVIDER: "google",
          GEMINI_API_KEY: "g-key",
          GEMINI_MODEL: "gemini-custom",
          META_API_KEY: "m-key",
        },
      });
      expect(snapshot.activeProvider).toBe("google");
      expect(snapshot.models).toEqual({ primary: "gemini-custom", fallback: "gemini-2.5-flash" });
      expect(snapshot.providers.google.configured).toBe(true);
      expect(snapshot.providers.google.fingerprint).toMatch(/^[0-9a-f]{8}$/);
      expect(snapshot.providers.meta).toMatchObject({
        configured: true,
        models: { primary: "meta-muse", fallback: "meta-muse" },
      });
      expect(snapshot.providers.openrouter.configured).toBe(false);
      expect(snapshot.openRouter.configured).toBe(false);
      expect(JSON.stringify(snapshot)).not.toContain("g-key");
      expect(JSON.stringify(snapshot)).not.toContain("m-key");
    });
  });

  it("falls back to openrouter for an unknown active provider", () => {
    withDatabase((t) => {
      const snapshot = getSettingsSnapshot(t.handle, {
        paths: pathsFor(t),
        env: { ACTIVE_AI_PROVIDER: "anthropic" },
      });
      expect(snapshot.activeProvider).toBe("openrouter");
      expect(snapshot.models.primary).toBe("google/gemma-4-26b-a4b-it:free");
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
        activeProvider: "openrouter",
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

  it("switches the active provider and per-provider model chains", () => {
    withDatabase((t) => {
      const envFile = join(t.dir, ".env.local");
      writeFileSync(envFile, "OPENROUTER_MODEL=old\n");
      const result = switchModels(envFile, {
        provider: "google",
        googleModel: "gemini-2.5-pro",
        googleFallbackModel: "gemini-2.5-flash",
        metaModel: "meta-muse",
      });
      expect(result).toEqual({
        primary: "gemini-2.5-pro",
        fallback: "gemini-2.5-flash",
        activeProvider: "google",
        restartRequired: true,
      });
      const content = readFileSync(envFile, "utf8");
      expect(content).toContain("ACTIVE_AI_PROVIDER=google");
      expect(content).toContain("GEMINI_MODEL=gemini-2.5-pro");
      expect(content).toContain("GEMINI_FALLBACK_MODEL=gemini-2.5-flash");
      expect(content).toContain("META_MODEL=meta-muse");
      expect(content).toContain("OPENROUTER_MODEL=old");
    });
  });

  it("clears a provider fallback back to its default", () => {
    withDatabase((t) => {
      const envFile = join(t.dir, ".env.local");
      writeFileSync(
        envFile,
        "ACTIVE_AI_PROVIDER=meta\nMETA_FALLBACK_MODEL=stale\n",
      );
      const result = switchModels(envFile, { clearMetaFallback: true });
      expect(result.activeProvider).toBe("meta");
      expect(result.fallback).toBe("meta-muse");
      expect(readFileSync(envFile, "utf8")).toContain("# META_FALLBACK_MODEL removed by Settings");
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

describe("pingProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports each missing key without touching the network", async () => {
    await expect(pingProvider("google", {})).resolves.toMatchObject({
      ok: false,
      model: null,
      error: "GEMINI_API_KEY is not configured",
    });
    await expect(pingProvider("meta", {})).resolves.toMatchObject({
      ok: false,
      model: null,
      error: "META_API_KEY is not configured",
    });
  });

  it("rejects unknown providers", async () => {
    await expect(
      pingProvider("anthropic" as "google", { META_API_KEY: "k" }),
    ).rejects.toThrow("unknown AI provider");
  });

  it("pings Google through generateContent and validates the payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"ping":"ok"}' }] } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await pingProvider("google", { GEMINI_API_KEY: "k" });
    expect(result.ok).toBe(true);
    expect(result.model).toBe("gemini-2.5-pro");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("gemini-2.5-pro:generateContent");
  });

  it("pings Meta through the Responses endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ output_text: '{"ping":"ok"}' }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await pingProvider("meta", { META_API_KEY: "k", META_MODEL: "custom" });
    expect(result.ok).toBe(true);
    expect(result.model).toBe("custom");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://api.meta.ai/v1/responses");
  });

  it("fails closed on auth errors and unexpected payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "bad key" }),
    );
    const auth = await pingProvider("google", { GEMINI_API_KEY: "bad" });
    expect(auth.ok).toBe(false);
    expect(auth.model).toBe("gemini-2.5-pro");
    expect(auth.error).toContain("401");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ output_text: '{"ping":"nope"}' }),
    }));
    const payload = await pingProvider("meta", { META_API_KEY: "k" });
    expect(payload).toMatchObject({ ok: false, model: "meta-muse" });
    expect(payload.error).toContain("expected ping payload");
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
