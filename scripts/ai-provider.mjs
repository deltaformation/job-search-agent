/**
 * Single source of truth for AI provider selection. The tailoring and
 * salary provider CLIs plus the Settings ping resolve the active provider
 * here from `ACTIVE_AI_PROVIDER` (default: openrouter) and dispatch to
 * the matching client. Every client returns the same
 * `{ model, content }` envelope and throws `{ kind, status, message }`
 * errors, so callers branch on kind/status — never on `instanceof`.
 */

import {
  chatCompletions as openRouterChat,
  modelChain as openRouterChain,
} from "./openrouter-client.mjs";
import {
  chatCompletions as googleChat,
  modelChain as googleChain,
} from "./google-client.mjs";
import {
  chatCompletions as metaChat,
  modelChain as metaChain,
} from "./meta-client.mjs";

export const AI_PROVIDERS = ["openrouter", "google", "meta"];

export const PROVIDER_LABEL = {
  openrouter: "OpenRouter",
  google: "Google AI Studio",
  meta: "Meta Muse",
};

export const PROVIDER_KEY_ENV = {
  openrouter: "OPENROUTER_API_KEY",
  google: "GEMINI_API_KEY",
  meta: "META_API_KEY",
};

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {"openrouter" | "google" | "meta"}
 */
export function activeProviderId(env = process.env) {
  const raw = (env.ACTIVE_AI_PROVIDER ?? "").trim().toLowerCase();
  return AI_PROVIDERS.includes(raw) ? raw : "openrouter";
}

/**
 * @param {"openrouter" | "google" | "meta"} provider
 * @returns {string}
 */
export function providerKeyName(provider) {
  return PROVIDER_KEY_ENV[provider] ?? PROVIDER_KEY_ENV.openrouter;
}

/**
 * @param {"openrouter" | "google" | "meta"} provider
 * @returns {string}
 */
export function providerLabel(provider) {
  return PROVIDER_LABEL[provider] ?? PROVIDER_LABEL.openrouter;
}

/**
 * @param {"openrouter" | "google" | "meta"} provider
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function providerChain(provider, env = process.env) {
  if (provider === "google") {
    return googleChain(env);
  }
  if (provider === "meta") {
    return metaChain(env);
  }
  return openRouterChain(env);
}

/**
 * @param {"openrouter" | "google" | "meta"} provider
 * @param {{ apiKey: string, models: string[], messages: Array<Record<string, unknown>>, timeoutMs?: number, temperature?: number, diagnose?: (line: string) => void }} options
 * @returns {Promise<{ model: string, content: string }>}
 */
export function providerChat(provider, options) {
  if (provider === "google") {
    return googleChat(options);
  }
  if (provider === "meta") {
    return metaChat(options);
  }
  return openRouterChat(options);
}
