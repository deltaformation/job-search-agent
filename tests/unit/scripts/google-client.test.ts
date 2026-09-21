// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatCompletions,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_PRIMARY_MODEL,
  GoogleError,
  googleUrl,
  modelChain,
  shouldFailOver,
} from "../../../scripts/google-client.mjs";

describe("modelChain", () => {
  it("defaults to Pro then Flash", () => {
    expect(modelChain({})).toEqual([DEFAULT_PRIMARY_MODEL, DEFAULT_FALLBACK_MODEL]);
    expect(DEFAULT_PRIMARY_MODEL).toBe("gemini-2.5-pro");
    expect(DEFAULT_FALLBACK_MODEL).toBe("gemini-2.5-flash");
  });

  it("honors explicit models and dedupes identical pairs", () => {
    expect(modelChain({ GEMINI_MODEL: "a", GEMINI_FALLBACK_MODEL: "b" })).toEqual(["a", "b"]);
    expect(modelChain({ GEMINI_MODEL: "a", GEMINI_FALLBACK_MODEL: "a" })).toEqual(["a"]);
  });
});

describe("shouldFailOver", () => {
  it.each([400, 404, 408, 422, 429, 500, 502, 503, 504])("fails over on status %i", (status) => {
    expect(shouldFailOver(new GoogleError("status", status, "x"))).toBe(true);
  });

  it.each([401, 402, 403])("fails fast on status %i", (status) => {
    expect(shouldFailOver(new GoogleError("status", status, "x"))).toBe(false);
  });

  it("fails over on timeouts and network faults, never on garbage", () => {
    expect(shouldFailOver(new GoogleError("timeout", null, "x"))).toBe(true);
    expect(shouldFailOver(new GoogleError("network", null, "x"))).toBe(true);
    expect(shouldFailOver(new GoogleError("bad-response", null, "x"))).toBe(false);
    expect(shouldFailOver(null)).toBe(false);
    expect(shouldFailOver("429")).toBe(false);
  });
});

describe("chatCompletions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function okResponse(text: string) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text }] } }],
      }),
    };
  }

  function errResponse(status: number) {
    return {
      ok: false,
      status,
      text: async () => `failure-${status}`,
    };
  }

  it("targets generateContent with the key param and a JSON system instruction", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('{"a":1}'));
    vi.stubGlobal("fetch", fetchMock);
    const result = await chatCompletions({
      apiKey: "k",
      models: ["gemini-2.5-pro", "gemini-2.5-flash"],
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
    });
    expect(result).toEqual({ model: "gemini-2.5-pro", content: '{"a":1}' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe(googleUrl("gemini-2.5-pro", "k"));
    expect(url).toContain("generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent");
    expect(init.headers["x-goog-api-key"]).toBe("k");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      systemInstruction: { parts: [{ text: "be terse" }] },
      generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
    });
    expect(body["contents"]).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("strips models/ prefix in googleUrl", () => {
    expect(googleUrl("models/gemini-3.5-flash-lite", "k")).toBe(
      googleUrl("gemini-3.5-flash-lite", "k"),
    );
  });

  it("maps assistant turns to the model role", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await chatCompletions({
      apiKey: "k",
      models: ["m"],
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ],
    });
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { contents: Array<{ role: string }> };
    expect(body.contents.map((part) => part.role)).toEqual(["user", "model"]);
    expect(body).not.toHaveProperty("systemInstruction");
  });

  it("fails over on 429 and returns the secondary success", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      const model = url.includes("primary") ? "primary" : "secondary";
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

  it("treats a blocked prompt as a failover-eligible bad response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ promptFeedback: { blockReason: "SAFETY" } }),
      })
      .mockResolvedValueOnce(okResponse('{"b":2}'));
    vi.stubGlobal("fetch", fetchMock);
    const result = await chatCompletions({
      apiKey: "k",
      models: ["primary", "secondary"],
      messages: [],
    });
    expect(result).toEqual({ model: "secondary", content: '{"b":2}' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws the last error when every model fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errResponse(503)));
    const error = await chatCompletions({
      apiKey: "k",
      models: ["primary", "secondary"],
      messages: [],
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GoogleError);
    expect((error as GoogleError).status).toBe(503);
  });

  it("extracts Google API error message when available in response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () =>
          JSON.stringify({
            error: {
              code: 404,
              message: "models/gemini-3.5-flash-lite is not found for API version v1beta",
              status: "NOT_FOUND",
            },
          }),
      }),
    );
    const error = await chatCompletions({
      apiKey: "k",
      models: ["gemini-3.5-flash-lite"],
      messages: [],
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GoogleError);
    expect((error as GoogleError).status).toBe(404);
    expect((error as GoogleError).message).toContain(
      "models/gemini-3.5-flash-lite is not found for API version v1beta",
    );
  });

  it("never fails over on auth errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(403));
    vi.stubGlobal("fetch", fetchMock);
    const error = await chatCompletions({
      apiKey: "bad",
      models: ["primary", "secondary"],
      messages: [],
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GoogleError);
    expect((error as GoogleError).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails over on timeouts and network faults", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(okResponse('{"b":2}'));
    vi.stubGlobal("fetch", fetchMock);
    const result = await chatCompletions({
      apiKey: "k",
      models: ["a", "b", "c"],
      messages: [],
    });
    expect(result).toEqual({ model: "c", content: '{"b":2}' });
  });
});
