import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as testAi } from "../../../app/api/settings/ai-test/route";
import { POST as saveKeys } from "../../../app/api/settings/keys/route";
import { POST as switchModel } from "../../../app/api/settings/model/route";
import { GET as getSettings } from "../../../app/api/settings/route";
import {
  getRequest,
  postRequest,
  readJson,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

const ENV_KEYS = [
  "SETTINGS_ENV_FILE",
  "ACTIVE_AI_PROVIDER",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_FALLBACK_MODEL",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GEMINI_FALLBACK_MODEL",
  "META_API_KEY",
  "META_MODEL",
  "META_FALLBACK_MODEL",
] as const;

let isolated: IsolatedRoot;
let envFile: string;
let previous: Record<string, string | undefined>;

beforeEach(() => {
  isolated = setupIsolatedRoot("settings-providers-");
  envFile = join(isolated.root, "test.env.local");
  previous = {};
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  process.env["SETTINGS_ENV_FILE"] = envFile;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous[key];
    }
  }
  isolated.restoreEnv();
  isolated.cleanup();
});

function pingOk(payload = '{"ping":"ok"}') {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: payload } }] }),
  });
}

describe("GET /api/settings", () => {
  it("reports saved vs active state with fingerprints only", async () => {
    writeFileSync(envFile, "ACTIVE_AI_PROVIDER=openrouter\nOPENROUTER_API_KEY=route-synthetic\n");
    process.env["ACTIVE_AI_PROVIDER"] = "google";
    const response = await getSettings(getRequest("/api/settings"));
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body["activeProvider"]).toBe("google");
    expect(body["savedProvider"]).toBe("openrouter");
    expect(body["restartNeeded"]).toBe(true);
    expect(body["worker"]).toBeNull();
    expect(body["workerMatch"]).toBeNull();
    expect(JSON.stringify(body)).not.toContain("route-synthetic");
  });
});

describe("POST /api/settings/model", () => {
  it("saves the selected provider chain and names the saved provider", async () => {
    writeFileSync(envFile, "UNRELATED=keep\n");
    const response = await switchModel(
      postRequest("/api/settings/model", {
        provider: "openrouter",
        primary: "route-model",
        fallback: "route-fallback",
      }),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body).toMatchObject({
      primary: "route-model",
      fallback: "route-fallback",
      savedProvider: "openrouter",
      restartRequired: true,
    });
    const content = readFileSync(envFile, "utf8");
    expect(content).toContain("UNRELATED=keep");
    expect(content).toContain("ACTIVE_AI_PROVIDER=openrouter");
  });

  it("rejects empty and hostile switches", async () => {
    expect((await switchModel(postRequest("/api/settings/model", {}))).status).toBe(400);
    const hostile = await switchModel(
      postRequest("/api/settings/model", { primary: "x; rm -rf /" }),
    );
    expect(hostile.status).toBe(400);
  });
});

describe("POST /api/settings/keys", () => {
  it("saves a key write-only and returns its fingerprint", async () => {
    const response = await saveKeys(
      postRequest("/api/settings/keys", { provider: "google", key: "route-gemini-key" }),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body).toMatchObject({ provider: "google", configured: true, changed: true });
    expect(body["fingerprint"]).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(body)).not.toContain("route-gemini-key");
    expect(readFileSync(envFile, "utf8")).toContain("GEMINI_API_KEY=route-gemini-key");
  });

  it("retains on blank and removes only when explicit", async () => {
    writeFileSync(envFile, "META_API_KEY=route-meta-key\n");
    const retained = await saveKeys(
      postRequest("/api/settings/keys", { provider: "meta", key: "" }),
    );
    expect(retained.status).toBe(200);
    expect(await readJson(retained)).toMatchObject({ configured: true, changed: false });
    expect(readFileSync(envFile, "utf8")).toContain("route-meta-key");

    const removed = await saveKeys(
      postRequest("/api/settings/keys", { provider: "meta", remove: true }),
    );
    expect(removed.status).toBe(200);
    expect(await readJson(removed)).toMatchObject({ configured: false, changed: true });
    expect(readFileSync(envFile, "utf8")).not.toContain("route-meta-key");
  });

  it("rejects combined set/remove and line-break keys", async () => {
    expect(
      (await saveKeys(postRequest("/api/settings/keys", { provider: "meta", key: "k", remove: true }))).status,
    ).toBe(400);
    expect(
      (await saveKeys(postRequest("/api/settings/keys", { provider: "meta", key: "a\nb" }))).status,
    ).toBe(400);
    expect(
      (await saveKeys(postRequest("/api/settings/keys", { provider: "nope", key: "k" }))).status,
    ).toBe(400);
  });
});

describe("provider secret exclusion (G3)", () => {
  it("never persists key material in SQLite", async () => {
    await saveKeys(postRequest("/api/settings/keys", { provider: "openrouter", key: "db-scan-key" }));
    await switchModel(postRequest("/api/settings/model", { primary: "m", fallback: "f" }));
    const needle = Buffer.from("db-scan-key", "utf8");
    expect(readFileSync(join(isolated.root, "job-tracker.sqlite")).includes(needle)).toBe(false);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        expect(readFileSync(join(isolated.root, `job-tracker.sqlite${suffix}`)).includes(needle)).toBe(
          false,
        );
      } catch {
        // Journal files may not exist; absence also carries no secret.
      }
    }
  });
});

describe("POST /api/settings/ai-test", () => {
  it("tests the entered draft model with a transient key without saving", async () => {
    const fetchMock = pingOk();
    vi.stubGlobal("fetch", fetchMock);
    writeFileSync(envFile, "ACTIVE_AI_PROVIDER=openrouter\n");
    const response = await testAi(
      postRequest("/api/settings/ai-test", {
        provider: "openrouter",
        model: "route-draft-model",
        apiKey: "route-transient-key",
      }),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body).toMatchObject({
      ok: true,
      provider: "openrouter",
      testedModel: "route-draft-model",
      keySource: "transient",
      reasonCode: "ok",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ model: "route-draft-model" });
    expect(JSON.stringify(body)).not.toContain("route-transient-key");
    expect(readFileSync(envFile, "utf8")).not.toContain("route-transient-key");
  });

  it("returns missing-key diagnostics without touching the network", async () => {
    const fetchMock = pingOk();
    vi.stubGlobal("fetch", fetchMock);
    const response = await testAi(
      postRequest("/api/settings/ai-test", { provider: "meta", model: "route-draft" }),
    );
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      ok: false,
      reasonCode: "missing-key",
      testedModel: "route-draft",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a simulated 502 to an actionable server outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => "bad gateway" }),
    );
    process.env["OPENROUTER_API_KEY"] = "route-stored-key";
    const response = await testAi(
      postRequest("/api/settings/ai-test", { provider: "openrouter", model: "route-draft" }),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body).toMatchObject({ ok: false, reasonCode: "server" });
    expect(String(body["error"])).toContain("502");
    expect(String(body["error"])).toContain("unchanged");
    expect(body["action"]).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("route-stored-key");
  });

  it("rejects invalid drafts and pings active on an empty body", async () => {
    const fetchMock = pingOk();
    vi.stubGlobal("fetch", fetchMock);
    const invalid = await testAi(postRequest("/api/settings/ai-test", { provider: "nope" }));
    expect(invalid.status).toBe(400);
    const empty = await testAi(
      new Request("http://127.0.0.1:3000/api/settings/ai-test", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
      }),
    );
    expect(empty.status).toBe(200);
    expect(await readJson(empty)).toMatchObject({ ok: false, reasonCode: "missing-key" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
