/**
 * Shared OpenRouter chat client for provider scripts (tailoring +
 * salary-facts). Tries the primary model first and fails over to the
 * secondary model on rate limits, overload/transport failures, and
 * timeouts. Authentication and bad-request failures never fail over —
 * retrying those against a second model cannot help.
 *
 * Pure decision helpers (`modelChain`, `shouldFailOver`) are unit-tested
 * from `tests/unit/scripts/openrouter-client.test.ts`; `chatCompletions`
 * is exercised there with a stubbed fetch.
 */

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_PRIMARY_MODEL = "google/gemma-4-26b-a4b-it:free";
export const DEFAULT_FALLBACK_MODEL = "nvidia/nemotron-3.5-lightning:free";

export class OpenRouterError extends Error {
  constructor(kind, status, message) {
    super(message);
    this.kind = kind;
    this.status = status ?? null;
  }
}

/**
 * Ordered model chain: explicit `OPENROUTER_MODEL`, else the Gemma
 * default, then `OPENROUTER_FALLBACK_MODEL` (else Nemotron) unless it
 * duplicates the primary.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function modelChain(env = process.env) {
  const primary = env.OPENROUTER_MODEL || DEFAULT_PRIMARY_MODEL;
  const secondary = env.OPENROUTER_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;
  return primary === secondary ? [primary] : [primary, secondary];
}

/**
 * Failover-eligible failures: every status except auth (401/402/403),
 * plus transport failures and aborts. Only auth fails fast — the second
 * model shares the key, so it would fail identically. Everything else
 * (unknown model, rate limit, overload, bad request) is worth one retry
 * against the secondary model: a 400 may be an invalid primary model ID
 * the secondary does not share.
 */
export function shouldFailOver(error) {
  if (error === null || typeof error !== "object") {
    return false;
  }
  if (error.kind === "timeout" || error.kind === "network") {
    return true;
  }
  if (error.kind !== "status" || typeof error.status !== "number") {
    return false;
  }
  return error.status !== 401 && error.status !== 402 && error.status !== 403;
}

function classifyStatus(status) {
  return new OpenRouterError("status", status, `OpenRouter API error ${status}`);
}

/**
 * POST chat completions, trying each model in `models` order.
 * Returns `{ model, content }` with the raw assistant content of the
 * first success. Throws the last `OpenRouterError` when every model
 * fails (auth/client errors throw on the first attempt). `diagnose`
 * receives one line per failed attempt for stderr logging.
 *
 * @param {{ apiKey: string, models: string[], messages: Array<Record<string, unknown>>, timeoutMs?: number, temperature?: number, diagnose?: (line: string) => void }} options
 * @returns {Promise<{ model: string, content: string }>}
 */
export async function chatCompletions({
  apiKey,
  models,
  messages,
  timeoutMs = 60000,
  temperature = 0.1,
  diagnose = () => {},
}) {
  let lastError = null;
  for (const model of models) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        lastError = classifyStatus(res.status);
        diagnose(`model ${model}: OpenRouter API error ${res.status}: ${errText.slice(0, 300)}`);
        if (!shouldFailOver(lastError)) {
          throw lastError;
        }
        continue;
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content === "") {
        lastError = new OpenRouterError("bad-response", null, `model ${model}: empty content`);
        diagnose(`model ${model}: empty content from OpenRouter API`);
        continue;
      }
      return { model, content };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof OpenRouterError) {
        if (err.kind === "status" && !shouldFailOver(err)) {
          throw err;
        }
        lastError = err;
        continue;
      }
      const aborted = err?.name === "AbortError";
      lastError = aborted
        ? new OpenRouterError("timeout", null, `model ${model}: timed out after ${timeoutMs}ms`)
        : new OpenRouterError("network", null, `model ${model}: ${err?.message ?? err}`);
      diagnose(`model ${model}: ${lastError.message}`);
    }
  }
  throw lastError ?? new OpenRouterError("network", null, "no models attempted");
}
