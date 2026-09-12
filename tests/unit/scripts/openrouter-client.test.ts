// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatCompletions,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_PRIMARY_MODEL,
  modelChain,
  OpenRouterError,
  shouldFailOver,
} from "../../../scripts/openrouter-client.mjs";

describe("modelChain", () => {
  it("defaults to Gemma then Nemotron", () => {
    expect(modelChain({})).toEqual([DEFAULT_PRIMARY_MODEL, DEFAULT_FALLBACK_MODEL]);
    expect(DEFAULT_PRIMARY_MODEL).toBe("google/gemma-4-26b-a4b-it:free");
    expect(DEFAULT_FALLBACK_MODEL).toBe("nvidia/nemotron-3.5-lightning:free");
  });

  it("honors explicit models and dedupes identical pairs", () => {
    expect(modelChain({ OPENROUTER_MODEL: "a", OPENROUTER_FALLBACK_MODEL: "b" })).toEqual(["a", "b"]);
    expect(modelChain({ OPENROUTER_MODEL: "a", OPENROUTER_FALLBACK_MODEL: "a" })).toEqual(["a"]);
  });
});

describe("shouldFailOver", () => {
  it.each([400, 404, 408, 422, 429, 500, 502, 503, 504])("fails over on status %i", (status) => {
    expect(shouldFailOver(new OpenRouterError("status", status, "x"))).toBe(true);
  });

  it.each([401, 402, 403])("fails fast on status %i", (status) => {
    expect(shouldFailOver(new OpenRouterError("status", status, "x"))).toBe(false);
  });

  it("fails over on timeouts and network faults, never on garbage", () => {
    expect(shouldFailOver(new OpenRouterError("timeout", null, "x"))).toBe(true);
    expect(shouldFailOver(new OpenRouterError("network", null, "x"))).toBe(true);
    expect(shouldFailOver(new OpenRouterError("bad-response", null, "x"))).toBe(false);
    expect(shouldFailOver(null)).toBe(false);
    expect(shouldFailOver("429")).toBe(false);
  });
});

describe("chatCompletions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function okResponse(content: string) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    };
  }

  function errResponse(status: number) {
    return {
      ok: false,
      status,
      text: async () => `failure-${status}`,
    };
  }

  it("returns the primary success without touching the secondary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('{"a":1}'));
    vi.stubGlobal("fetch", fetchMock);
    const result = await chatCompletions({
      apiKey: "k",
      models: ["primary", "secondary"],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toEqual({ model: "primary", content: '{"a":1}' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body).model).toBe(
      "primary",
    );
  });

  it("fails over on 429 and returns the secondary success", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const model = (JSON.parse(init.body) as { model: string }).model;
      seen.push(model);
      return model === "primary" ? errResponse(429) : okResponse('{"b":2}');
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errResponse(503)));
    const error = await chatCompletions({
      apiKey: "k",
      models: ["primary", "secondary"],
      messages: [],
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(OpenRouterError);
    expect((error as OpenRouterError).status).toBe(503);
  });

  it("never fails over on auth errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(401));
    vi.stubGlobal("fetch", fetchMock);
    const error = await chatCompletions({
      apiKey: "bad",
      models: ["primary", "secondary"],
      messages: [],
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(OpenRouterError);
    expect((error as OpenRouterError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
