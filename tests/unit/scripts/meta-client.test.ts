// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatCompletions,
  DEFAULT_PRIMARY_MODEL,
  MetaError,
  META_URL,
  modelChain,
  shouldFailOver,
} from "../../../scripts/meta-client.mjs";

describe("modelChain", () => {
  it("defaults to a single meta-muse model", () => {
    expect(modelChain({})).toEqual([DEFAULT_PRIMARY_MODEL]);
    expect(DEFAULT_PRIMARY_MODEL).toBe("meta-muse");
  });

  it("honors explicit models and dedupes identical pairs", () => {
    expect(modelChain({ META_MODEL: "a", META_FALLBACK_MODEL: "b" })).toEqual(["a", "b"]);
    expect(modelChain({ META_MODEL: "a", META_FALLBACK_MODEL: "a" })).toEqual(["a"]);
    expect(modelChain({ META_MODEL: "custom" })).toEqual(["custom"]);
  });
});

describe("shouldFailOver", () => {
  it.each([400, 404, 408, 422, 429, 500, 502, 503, 504])("fails over on status %i", (status) => {
    expect(shouldFailOver(new MetaError("status", status, "x"))).toBe(true);
  });

  it.each([401, 402, 403])("fails fast on status %i", (status) => {
    expect(shouldFailOver(new MetaError("status", status, "x"))).toBe(false);
  });

  it("fails over on timeouts and network faults, never on garbage", () => {
    expect(shouldFailOver(new MetaError("timeout", null, "x"))).toBe(true);
    expect(shouldFailOver(new MetaError("network", null, "x"))).toBe(true);
    expect(shouldFailOver(new MetaError("bad-response", null, "x"))).toBe(false);
    expect(shouldFailOver(null)).toBe(false);
    expect(shouldFailOver("429")).toBe(false);
  });
});

describe("chatCompletions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function okResponse(body: unknown) {
    return { ok: true, status: 200, json: async () => body };
  }

  function errResponse(status: number) {
    return {
      ok: false,
      status,
      text: async () => `failure-${status}`,
    };
  }

  it("posts Bearer JSON to the Responses endpoint and reads output_text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ output_text: '{"a":1}' }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await chatCompletions({
      apiKey: "k",
      models: ["meta-muse"],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toEqual({ model: "meta-muse", content: '{"a":1}' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe(META_URL);
    expect(META_URL).toBe("https://api.meta.ai/v1/responses");
    expect(init.headers["Authorization"]).toBe("Bearer k");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "meta-muse",
      input: [{ role: "user", content: "hi" }],
      stream: false,
      response_format: { type: "json_object" },
    });
  });

  it.each([
    ["output items", { output: [{ content: [{ text: '{"b":2}' }] }] }],
    ["chat shape", { choices: [{ message: { content: '{"c":3}' } }] }],
  ])("tolerates the %s response shape", async (_label, body) => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    const result = await chatCompletions({ apiKey: "k", models: ["m"], messages: [] });
    expect(result.content).toMatch(/^\{"[bc]":\d\}$/);
  });

  it("fails over on 429 and returns the secondary success", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const model = (JSON.parse(init.body) as { model: string }).model;
      seen.push(model);
      return model === "primary" ? errResponse(429) : okResponse({ output_text: '{"b":2}' });
    });
    vi.stubGlobal("fetch", fetchMock);
    const diagnosed: string[] = [];
    const result = await chatCompletions({
      apiKey: "k",
      models: ["primary", "secondary"],
      messages: [],
      diagnose: (line: string) => diagnosed.push(line),
    });
    expect(result).toEqual({ model: "secondary", content: '{"b":2}' });
    expect(seen).toEqual(["primary", "secondary"]);
    expect(diagnosed).toHaveLength(1);
    expect(diagnosed[0]).toContain("429");
  });

  it("throws the last error when every model fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errResponse(500)));
    const error = await chatCompletions({
      apiKey: "k",
      models: ["only"],
      messages: [],
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MetaError);
    expect((error as MetaError).status).toBe(500);
  });

  it("never fails over on auth errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(401));
    vi.stubGlobal("fetch", fetchMock);
    const error = await chatCompletions({
      apiKey: "bad",
      models: ["primary", "secondary"],
      messages: [],
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MetaError);
    expect((error as MetaError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails over on timeouts and network faults", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(okResponse({ output_text: '{"b":2}' }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await chatCompletions({
      apiKey: "k",
      models: ["a", "b", "c"],
      messages: [],
    });
    expect(result).toEqual({ model: "c", content: '{"b":2}' });
  });
});
