// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeProviderId,
  AI_PROVIDERS,
  providerChain,
  providerChat,
  providerKeyName,
  providerLabel,
} from "../../../scripts/ai-provider.mjs";

describe("activeProviderId", () => {
  it("defaults to openrouter and validates the env value", () => {
    expect(activeProviderId({})).toBe("openrouter");
    expect(activeProviderId({ ACTIVE_AI_PROVIDER: "google" })).toBe("google");
    expect(activeProviderId({ ACTIVE_AI_PROVIDER: "  Meta " })).toBe("meta");
    expect(activeProviderId({ ACTIVE_AI_PROVIDER: "anthropic" })).toBe("openrouter");
    expect(activeProviderId({ ACTIVE_AI_PROVIDER: "" })).toBe("openrouter");
  });
});

describe("provider metadata", () => {
  it("names every provider, key, and label", () => {
    expect(AI_PROVIDERS).toEqual(["openrouter", "google", "meta"]);
    expect(providerKeyName("openrouter")).toBe("OPENROUTER_API_KEY");
    expect(providerKeyName("google")).toBe("GEMINI_API_KEY");
    expect(providerKeyName("meta")).toBe("META_API_KEY");
    expect(providerLabel("openrouter")).toBe("OpenRouter");
    expect(providerLabel("google")).toBe("Google AI Studio");
    expect(providerLabel("meta")).toBe("Meta Muse");
  });
});

describe("providerChain", () => {
  it("dispatches to each provider chain", () => {
    expect(providerChain("openrouter", { OPENROUTER_MODEL: "a" })[0]).toBe("a");
    expect(providerChain("google", {})).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);
    expect(providerChain("meta", {})).toEqual(["meta-muse"]);
    expect(providerChain("meta", { META_MODEL: "m", META_FALLBACK_MODEL: "f" })).toEqual(["m", "f"]);
  });
});

describe("providerChat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dispatches each provider to its own endpoint", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        if (url.includes("generativelanguage")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }),
          };
        }
        if (url.includes("api.meta.ai")) {
          return { ok: true, status: 200, json: async () => ({ output_text: "{}" }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: "{}" } }] }),
        };
      }),
    );
    const openrouter = await providerChat("openrouter", {
      apiKey: "k",
      models: ["o"],
      messages: [],
    });
    const google = await providerChat("google", {
      apiKey: "k",
      models: ["gemini-2.5-pro"],
      messages: [],
    });
    const meta = await providerChat("meta", {
      apiKey: "k",
      models: ["meta-muse"],
      messages: [],
    });
    expect(openrouter).toEqual({ model: "o", content: "{}" });
    expect(google).toEqual({ model: "gemini-2.5-pro", content: "{}" });
    expect(meta).toEqual({ model: "meta-muse", content: "{}" });
    expect(seen[0]).toContain("openrouter.ai");
    expect(seen[1]).toContain("gemini-2.5-pro:generateContent");
    expect(seen[2]).toBe("https://api.meta.ai/v1/responses");
  });
});
