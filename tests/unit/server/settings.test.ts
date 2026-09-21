// @vitest-environment node
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../src/db/testing";
import type { DataRootPaths } from "../../../src/security/data-root";
import {
  getSettingsSnapshot,
  masterResumePath,
  pingOpenRouter,
  pingProvider,
  readSavedProviderConfig,
  resyncMasterResume,
  saveProviderKey,
  switchModels,
  testProviderDraft,
} from "../../../src/server/settings";
import { buildWorkerStatus, writeWorkerStatus } from "../../../src/worker/status";

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

function sourcesFor(t: ReturnType<typeof createTestDatabase>): string {
  const sourcesDir = join(t.dir, "sources");
  mkdirSync(sourcesDir, { recursive: true });
  return sourcesDir;
}

function pathsFor(t: ReturnType<typeof createTestDatabase>): DataRootPaths {
  const evidenceDir = join(t.dir, "evidence");
  const artifactsDir = join(t.dir, "artifacts");
  const sourcesDir = join(t.dir, "sources");
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(sourcesDir, { recursive: true });
  return { root: t.dir, databasePath: t.dbPath, evidenceDir, artifactsDir, sourcesDir };
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
        envFilePath: join(t.dir, ".env.local"),
      });
      expect(snapshot.savedProvider).toBe("openrouter");
      expect(snapshot.restartNeeded).toBe(true);
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
      const snapshot = getSettingsSnapshot(t.handle, {
        paths: pathsFor(t),
        env: {},
        envFilePath: join(t.dir, ".env.local"),
      });
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
        envFilePath: join(t.dir, ".env.local"),
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
        envFilePath: join(t.dir, ".env.local"),
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
        savedProvider: "openrouter",
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
        savedProvider: "google",
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
      error:
        "OPENROUTER_API_KEY is not configured. Enter a key to test, or save one first — the draft model was not pinged.",
      provider: "openrouter",
      testedModel: "google/gemma-4-26b-a4b-it:free",
      keySource: "stored",
      reasonCode: "missing-key",
      action: "Enter an OpenRouter key in the test field, or save one under Settings → AI & Models.",
      fallback: null,
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
      reasonCode: "missing-key",
      keySource: "stored",
    });
    await expect(pingProvider("meta", {})).resolves.toMatchObject({
      ok: false,
      model: null,
      reasonCode: "missing-key",
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

describe("saved configuration and restart state", () => {
  it("reproduces the reported state: OpenRouter saved while Google runs", () => {
    withDatabase((t) => {
      const envFile = join(t.dir, ".env.local");
      writeFileSync(
        envFile,
        [
          "ACTIVE_AI_PROVIDER=openrouter",
          "OPENROUTER_API_KEY=synthetic-openrouter-key",
          "OPENROUTER_MODEL=google/gemma-4-26b-a4b-it:free",
          "OPENROUTER_FALLBACK_MODEL=nvidia/nemotron-3.5-lightning:free",
          "",
        ].join("\n"),
      );
      const snapshot = getSettingsSnapshot(t.handle, {
        paths: pathsFor(t),
        env: { ACTIVE_AI_PROVIDER: "google" },
        envFilePath: envFile,
      });
      // Saved (file) vs active (process) stay distinct: the UI draft
      // baseline is the saved OpenRouter config, not running Google.
      expect(snapshot.saved.exists).toBe(true);
      expect(snapshot.savedProvider).toBe("openrouter");
      expect(snapshot.saved.provider).toBe("openrouter");
      expect(snapshot.saved.providers.openrouter.configured).toBe(true);
      expect(snapshot.saved.providers.openrouter.models.primary).toBe(
        "google/gemma-4-26b-a4b-it:free",
      );
      expect(snapshot.activeProvider).toBe("google");
      expect(snapshot.providers.google.configured).toBe(false);
      // Restart is needed and the gap is named; saving alone never clears it.
      expect(snapshot.restartNeeded).toBe(true);
      expect(snapshot.restartDetail).toContain("OpenRouter");
      expect(snapshot.restartDetail).toContain("Google AI Studio");
      // Worker has not reported in this isolated root.
      expect(snapshot.worker).toBeNull();
      expect(snapshot.workerMatch).toBeNull();
      // Fingerprints only — never the saved key value.
      expect(JSON.stringify(snapshot)).not.toContain("synthetic-openrouter-key");
      expect(snapshot.saved.providers.openrouter.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  it("clears restart-needed only when saved and running agree", () => {
    withDatabase((t) => {
      const envFile = join(t.dir, ".env.local");
      const saved = switchModels(envFile, {
        provider: "openrouter",
        primary: "model-x",
        fallback: "model-y",
      });
      expect(saved.savedProvider).toBe("openrouter");
      saveProviderKey(envFile, { provider: "openrouter", key: "synthetic-key-1" });
      // Simulate the post-restart process environment: file values loaded.
      const env = {
        ACTIVE_AI_PROVIDER: "openrouter",
        OPENROUTER_MODEL: "model-x",
        OPENROUTER_FALLBACK_MODEL: "model-y",
        OPENROUTER_API_KEY: "synthetic-key-1",
      };
      const snapshot = getSettingsSnapshot(t.handle, {
        paths: pathsFor(t),
        env,
        envFilePath: envFile,
      });
      expect(snapshot.restartNeeded).toBe(false);
      expect(snapshot.restartDetail).toBeNull();
      expect(snapshot.worker).toBeNull();
    });
  });

  it("flags a replaced key and a stale worker report as restart gaps", () => {
    withDatabase((t) => {
      const paths = pathsFor(t);
      const envFile = join(t.dir, ".env.local");
      writeFileSync(envFile, "ACTIVE_AI_PROVIDER=google\nGEMINI_API_KEY=new-key\n");
      // Running process still holds the previous key; worker reported older models.
      writeWorkerStatus(
        t.dir,
        buildWorkerStatus({
          env: { ACTIVE_AI_PROVIDER: "google", GEMINI_MODEL: "stale-model" },
          workerId: "worker-test",
          startedAt: "2026-09-14T00:00:00.000Z",
          tailorConfigured: true,
        }),
      );
      const snapshot = getSettingsSnapshot(t.handle, {
        paths,
        env: { ACTIVE_AI_PROVIDER: "google", GEMINI_API_KEY: "old-key" },
        envFilePath: envFile,
      });
      expect(snapshot.restartNeeded).toBe(true);
      expect(snapshot.restartDetail).toContain("replaced");
      expect(snapshot.restartDetail).toContain("worker");
      expect(snapshot.worker?.provider).toBe("google");
      expect(snapshot.workerMatch).toBe(false);
      expect(JSON.stringify(snapshot)).not.toContain("new-key");
      expect(JSON.stringify(snapshot)).not.toContain("old-key");
    });
  });

  it("reports a matching worker as verified activation", () => {
    withDatabase((t) => {
      const paths = pathsFor(t);
      const envFile = join(t.dir, ".env.local");
      writeFileSync(
        envFile,
        "ACTIVE_AI_PROVIDER=meta\nMETA_API_KEY=synthetic-meta-key\nMETA_MODEL=meta-muse\n",
      );
      const env = {
        ACTIVE_AI_PROVIDER: "meta",
        META_API_KEY: "synthetic-meta-key",
        META_MODEL: "meta-muse",
      };
      writeWorkerStatus(
        t.dir,
        buildWorkerStatus({
          env,
          workerId: "worker-test",
          startedAt: "2026-09-14T00:00:00.000Z",
          tailorConfigured: true,
        }),
      );
      const snapshot = getSettingsSnapshot(t.handle, { paths, env, envFilePath: envFile });
      expect(snapshot.restartNeeded).toBe(false);
      expect(snapshot.worker?.provider).toBe("meta");
      expect(snapshot.worker?.keyConfigured).toBe(true);
      expect(snapshot.workerMatch).toBe(true);
    });
  });

  it("reads a missing env file as unsaved defaults", () => {
    withDatabase((t) => {
      const saved = readSavedProviderConfig(join(t.dir, "no-such-file.env"));
      expect(saved.exists).toBe(false);
      expect(saved.provider).toBe("openrouter");
      expect(saved.providers.openrouter.configured).toBe(false);
    });
  });
});

describe("saveProviderKey", () => {
  it("adds a key with owner-only permissions and preserves unrelated lines", () => {
    withDatabase((t) => {
      const envFile = join(t.dir, ".env.local");
      writeFileSync(envFile, "# comment\nOPENROUTER_MODEL=keep-me\nUNRELATED=1\n");
      const result = saveProviderKey(envFile, { provider: "google", key: "synthetic-gemini-key" });
      expect(result).toMatchObject({
        provider: "google",
        configured: true,
        changed: true,
      });
      expect(result.fingerprint).toMatch(/^[0-9a-f]{8}$/);
      expect(JSON.stringify(result)).not.toContain("synthetic-gemini-key");
      const content = readFileSync(envFile, "utf8");
      expect(content).toContain("# comment");
      expect(content).toContain("OPENROUTER_MODEL=keep-me");
      expect(content).toContain("UNRELATED=1");
      expect(content).toContain("GEMINI_API_KEY=synthetic-gemini-key");
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
    });
  });

  it("replaces an existing key and changes its fingerprint", () => {
    withDatabase((t) => {
      const envFile = join(t.dir, ".env.local");
      const first = saveProviderKey(envFile, { provider: "meta", key: "first-key" });
      const second = saveProviderKey(envFile, { provider: "meta", key: "second-key" });
      expect(first.configured).toBe(true);
      expect(second.configured).toBe(true);
      expect(second.changed).toBe(true);
      expect(second.fingerprint).not.toBe(first.fingerprint);
      const content = readFileSync(envFile, "utf8");
      expect(content).toContain("META_API_KEY=second-key");
      expect(content).not.toContain("first-key");
    });
  });

  it("treats a blank key as retain without touching the file", () => {
    withDatabase((t) => {
      const envFile = join(t.dir, ".env.local");
      writeFileSync(envFile, "OPENROUTER_API_KEY=keep-this-key\n");
      const before = readFileSync(envFile, "utf8");
      const result = saveProviderKey(envFile, { provider: "openrouter", key: "   " });
      expect(result.changed).toBe(false);
      expect(result.configured).toBe(true);
      expect(result.message).toContain("retained");
      expect(readFileSync(envFile, "utf8")).toBe(before);
      const omitted = saveProviderKey(envFile, { provider: "openrouter" });
      expect(omitted.changed).toBe(false);
      expect(readFileSync(envFile, "utf8")).toBe(before);
    });
  });

  it("removes only with explicit remove and reports no-op when absent", () => {
    withDatabase((t) => {
      const envFile = join(t.dir, ".env.local");
      writeFileSync(envFile, "OPENROUTER_API_KEY=drop-me\nOPENROUTER_MODEL=keep\n");
      const removed = saveProviderKey(envFile, { provider: "openrouter", remove: true });
      expect(removed).toMatchObject({ configured: false, fingerprint: null, changed: true });
      const content = readFileSync(envFile, "utf8");
      expect(content).not.toContain("drop-me");
      expect(content).toContain("OPENROUTER_MODEL=keep");
      const again = saveProviderKey(envFile, { provider: "openrouter", remove: true });
      expect(again.changed).toBe(false);
      expect(again.message).toContain("nothing to remove");
    });
  });

  it("rejects combined set/remove and keys with line breaks", () => {
    withDatabase((t) => {
      const envFile = join(t.dir, ".env.local");
      expect(() =>
        saveProviderKey(envFile, { provider: "google", key: "k", remove: true }),
      ).toThrow("cannot set and remove");
      expect(() => saveProviderKey(envFile, { provider: "google", key: "a\nB=1" })).toThrow(
        "line breaks",
      );
      expect(() => saveProviderKey(envFile, { provider: "nope", key: "k" })).toThrow();
    });
  });
});

describe("testProviderDraft", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function pingOk(payload = '{"ping":"ok"}') {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: payload } }] }),
    });
  }

  it("tests the entered draft model without saving anything", async () => {
    const fetchMock = pingOk();
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      OPENROUTER_API_KEY: "stored-synthetic",
      OPENROUTER_MODEL: "active-model",
    };
    const result = await testProviderDraft({ provider: "openrouter", model: "draft-model" }, env);
    expect(result.ok).toBe(true);
    expect(result.testedModel).toBe("draft-model");
    expect(result.keySource).toBe("stored");
    expect(result.reasonCode).toBe("ok");
    expect(result.fallback).toBeNull();
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ model: "draft-model" });
    expect(env["OPENROUTER_MODEL"]).toBe("active-model");
    expect(JSON.stringify(result)).not.toContain("stored-synthetic");
  });

  it("tests primary and fallback drafts independently", async () => {
    const fetchMock = pingOk();
    vi.stubGlobal("fetch", fetchMock);
    const result = await testProviderDraft(
      { provider: "openrouter", model: "draft-a", fallbackModel: "draft-b" },
      { OPENROUTER_API_KEY: "stored-synthetic" },
    );
    expect(result.ok).toBe(true);
    expect(result.fallback).toMatchObject({ ok: true, model: "draft-b" });
    // Both drafts were pinged independently with exact model ids.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse((init as { body: string }).body),
    );
    expect(bodies.map((body) => body.model)).toEqual(["draft-a", "draft-b"]);
  });

  it("uses a transient key without saving and reports its source", async () => {
    const fetchMock = pingOk();
    vi.stubGlobal("fetch", fetchMock);
    const result = await testProviderDraft(
      { provider: "openrouter", model: "draft-model", apiKey: "transient-synthetic" },
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.keySource).toBe("transient");
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers["Authorization"]).toBe("Bearer transient-synthetic");
    expect(JSON.stringify(result)).not.toContain("transient-synthetic");
  });

  it("reports missing key without touching the network", async () => {
    const fetchMock = pingOk();
    vi.stubGlobal("fetch", fetchMock);
    const result = await testProviderDraft({ provider: "google", model: "draft-g" }, {});
    expect(result).toMatchObject({
      ok: false,
      model: null,
      reasonCode: "missing-key",
      testedModel: "draft-g",
    });
    expect(result.action).toContain("save one");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { status: 401, reasonCode: "auth", hint: "credits" },
    { status: 429, reasonCode: "rate-limit", hint: "quota" },
    { status: 502, reasonCode: "server", hint: "unchanged" },
    { status: 400, reasonCode: "invalid-request", hint: "draft-model" },
  ])("classifies HTTP $status as $reasonCode with an action", async ({ status, reasonCode, hint }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status, text: async () => "upstream says no" }),
    );
    const result = await testProviderDraft(
      { provider: "openrouter", model: "draft-model" },
      { OPENROUTER_API_KEY: "stored-synthetic" },
    );
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe(reasonCode);
    expect(result.testedModel).toBe("draft-model");
    expect(`${result.error} ${result.action}`).toContain(hint);
    expect(result.action).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain("stored-synthetic");
  });

  it("classifies timeouts and unexpected payloads without secrets", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    const timedOut = await testProviderDraft(
      { provider: "meta", model: "draft-m" },
      { META_API_KEY: "stored-synthetic" },
    );
    expect(timedOut).toMatchObject({ ok: false, reasonCode: "timeout" });
    expect(timedOut.action).toContain("connectivity");

    vi.stubGlobal("fetch", pingOk('{"ping":"nope"}'));
    const payload = await testProviderDraft(
      { provider: "meta", model: "draft-m" },
      { META_API_KEY: "stored-synthetic" },
    );
    expect(payload).toMatchObject({ ok: false, reasonCode: "bad-response" });
    expect(JSON.stringify(payload)).not.toContain("stored-synthetic");
  });

  it("rejects invalid drafts without a network call", async () => {
    const fetchMock = pingOk();
    vi.stubGlobal("fetch", fetchMock);
    await expect(testProviderDraft({ provider: "nope" }, {})).rejects.toThrow();
    await expect(
      testProviderDraft({ provider: "google", model: "bad model!" }, { GEMINI_API_KEY: "k" }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("resyncMasterResume", () => {
  it("imports and activates the master resume, then no-ops when current", () => {
    withDatabase((t) => {
      const candidateDir = join(t.dir, "candidate");
      mkdirSync(candidateDir, { recursive: true });
      const master = masterResumePath(candidateDir);
      writeFileSync(master, JSON.stringify(fixtureDocument()));
      const first = resyncMasterResume(t.handle, master, { sourcesDir: sourcesFor(t) });
      expect(first.ok).toBe(true);
      if (!first.ok) {
        return;
      }
      expect(first.activated).toBe(true);
      expect(first.alreadyCurrent).toBe(false);
      const second = resyncMasterResume(t.handle, master, { sourcesDir: sourcesFor(t) });
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
      const first = resyncMasterResume(t.handle, master, { sourcesDir: sourcesFor(t) });
      expect(first.ok).toBe(true);
      // Edited content hashes differently from the latest version, so
      // resync imports it as a new version and activates it.
      const edited = { ...document, summary: "Edited summary for version two" };
      writeFileSync(master, JSON.stringify(edited));
      const second = resyncMasterResume(t.handle, master, { sourcesDir: sourcesFor(t) });
      expect(second.ok).toBe(true);
      if (!second.ok) {
        return;
      }
      expect(second.alreadyCurrent).toBe(false);
    });
  });

  it("reports missing and invalid master files without touching versions", () => {
    withDatabase((t) => {
      const missing = resyncMasterResume(t.handle, join(t.dir, "nope", "master-resume.json"), { sourcesDir: sourcesFor(t) });
      expect(missing).toMatchObject({ ok: false, error: "master-resume-missing" });
      const badPath = join(t.dir, "bad.json");
      writeFileSync(badPath, "{not json");
      expect(resyncMasterResume(t.handle, badPath, { sourcesDir: sourcesFor(t) })).toMatchObject({
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
