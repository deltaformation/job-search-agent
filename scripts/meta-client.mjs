/**
 * Shared Meta Muse client for provider scripts (tailoring +
 * salary-facts). Mirrors `openrouter-client.mjs`: tries the primary model
 * first and fails over to `META_FALLBACK_MODEL` when one is configured.
 * Authentication failures never fail over — the second model shares the
 * key, so it would fail identically.
 *
 * Responses API with Bearer auth and structured JSON output via
 * `response_format: { type: "json_object" }`. Response parsing is
 * deliberately tolerant (`output_text`, then `output[].content[].text`,
 * then the chat-completions shape) so minor API version skew surfaces
 * content instead of a bad-response failure.
 *
 * Pure decision helpers (`modelChain`, `shouldFailOver`) are unit-tested
 * from `tests/unit/scripts/meta-client.test.ts`; `chatCompletions`
 * is exercised there with a stubbed fetch.
 */

export const META_URL = "https://api.meta.ai/v1/responses";
export const DEFAULT_PRIMARY_MODEL = "meta-muse";

export class MetaError extends Error {
  constructor(kind, status, message) {
    super(message);
    this.kind = kind;
    this.status = status ?? null;
  }
}

/**
 * Ordered model chain: explicit `META_MODEL`, else meta-muse, then
 * `META_FALLBACK_MODEL` when set (no default second model) unless it
 * duplicates the primary.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function modelChain(env = process.env) {
  const primary = env.META_MODEL || DEFAULT_PRIMARY_MODEL;
  const secondary = env.META_FALLBACK_MODEL || "";
  if (secondary === "" || secondary === primary) {
    return [primary];
  }
  return [primary, secondary];
}

/**
 * Failover-eligible failures: every status except auth (401/402/403),
 * plus transport failures and aborts. A 400 may be an invalid primary
 * model ID the secondary does not share.
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
  return new MetaError("status", status, `Meta API error ${status}`);
}

function extractText(data, model) {
  if (typeof data?.output_text === "string" && data.output_text !== "") {
    return data.output_text;
  }
  if (Array.isArray(data?.output)) {
    const text = data.output
      .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
    if (text !== "") {
      return text;
    }
  }
  const chat = data?.choices?.[0]?.message?.content;
  if (typeof chat === "string" && chat !== "") {
    return chat;
  }
  throw new MetaError("bad-response", null, `model ${model}: empty content`);
}

/**
 * POST a response request, trying each model in `models` order.
 * Returns `{ model, content }` with the text of the first success.
 * Throws the last `MetaError` when every model fails. `diagnose`
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
      const res = await fetch(META_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: messages,
          temperature,
          stream: false,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        lastError = classifyStatus(res.status);
        diagnose(`model ${model}: Meta API error ${res.status}: ${errText.slice(0, 300)}`);
        if (!shouldFailOver(lastError)) {
          throw lastError;
        }
        continue;
      }
      const data = await res.json();
      try {
        return { model, content: extractText(data, model) };
      } catch (err) {
        lastError = err;
        diagnose(`model ${model}: ${err.message}`);
        continue;
      }
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof MetaError) {
        if (err.kind === "status" && !shouldFailOver(err)) {
          throw err;
        }
        lastError = err;
        continue;
      }
      const aborted = err?.name === "AbortError";
      lastError = aborted
        ? new MetaError("timeout", null, `model ${model}: timed out after ${timeoutMs}ms`)
        : new MetaError("network", null, `model ${model}: ${err?.message ?? err}`);
      diagnose(`model ${model}: ${lastError.message}`);
    }
  }
  throw lastError ?? new MetaError("network", null, "no models attempted");
}
