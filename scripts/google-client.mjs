/**
 * Shared Google AI Studio (Gemini) client for provider scripts (tailoring +
 * salary-facts). Mirrors `openrouter-client.mjs`: tries the primary model
 * first and fails over to the secondary model on rate limits,
 * overload/transport failures, and timeouts. Authentication failures never
 * fail over — the second model shares the key, so it would fail identically.
 *
 * The key travels as a `?key=` query parameter (the generateContent
 * contract); it is never written to diagnostics. Structured JSON output
 * via `responseMimeType: "application/json"`.
 *
 * Pure decision helpers (`modelChain`, `shouldFailOver`) are unit-tested
 * from `tests/unit/scripts/google-client.test.ts`; `chatCompletions`
 * is exercised there with a stubbed fetch.
 */

export const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_PRIMARY_MODEL = "gemini-2.5-pro";
export const DEFAULT_FALLBACK_MODEL = "gemini-2.5-flash";

export function googleUrl(model, apiKey) {
  const cleanModel = String(model).replace(/^models\//, "");
  return `${GOOGLE_API_BASE}/models/${cleanModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

export class GoogleError extends Error {
  constructor(kind, status, message) {
    super(message);
    this.kind = kind;
    this.status = status ?? null;
  }
}

/**
 * Ordered model chain: explicit `GEMINI_MODEL`, else gemini-2.5-pro,
 * then `GEMINI_FALLBACK_MODEL` (else gemini-2.5-flash) unless it
 * duplicates the primary.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function modelChain(env = process.env) {
  const primary = env.GEMINI_MODEL || DEFAULT_PRIMARY_MODEL;
  const secondary = env.GEMINI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;
  return primary === secondary ? [primary] : [primary, secondary];
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

function classifyStatus(status, errText) {
  let message = `Google API error ${status}`;
  if (typeof errText === "string" && errText.trim() !== "") {
    try {
      const parsed = JSON.parse(errText);
      const apiMsg = parsed?.error?.message;
      if (typeof apiMsg === "string" && apiMsg.trim() !== "") {
        message = `Google API error ${status}: ${apiMsg.trim()}`;
      }
    } catch {
      // not JSON
    }
  }
  return new GoogleError("status", status, message);
}

/**
 * Split chat messages into a Gemini request: system prompts become
 * `systemInstruction`, the rest become `contents` (`assistant` maps to
 * the Gemini `model` role).
 */
function toGeminiRequest(messages, temperature) {
  const systems = [];
  const contents = [];
  for (const message of messages) {
    const text = typeof message?.content === "string" ? message.content : "";
    if (message?.role === "system") {
      systems.push(text);
    } else {
      contents.push({
        role: message?.role === "assistant" ? "model" : "user",
        parts: [{ text }],
      });
    }
  }
  const body = {
    contents,
    generationConfig: { temperature, responseMimeType: "application/json" },
  };
  if (systems.length > 0) {
    body.systemInstruction = { parts: [{ text: systems.join("\n\n") }] };
  }
  return body;
}

function extractText(data, model) {
  const blockReason = data?.promptFeedback?.blockReason;
  if (typeof blockReason === "string" && blockReason !== "" && blockReason !== "BLOCK_REASON_UNSPECIFIED") {
    throw new GoogleError("bad-response", null, `model ${model}: prompt blocked (${blockReason})`);
  }
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
    : "";
  if (text === "") {
    throw new GoogleError("bad-response", null, `model ${model}: empty content`);
  }
  return text;
}

/**
 * POST generateContent, trying each model in `models` order.
 * Returns `{ model, content }` with the joined text of the first
 * success. Throws the last `GoogleError` when every model fails.
 * `diagnose` receives one line per failed attempt for stderr logging.
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
      const res = await fetch(googleUrl(model, apiKey), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(toGeminiRequest(messages, temperature)),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        lastError = classifyStatus(res.status, errText);
        diagnose(`model ${model}: Google API error ${res.status}: ${errText.slice(0, 300)}`);
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
      if (err instanceof GoogleError) {
        if (err.kind === "status" && !shouldFailOver(err)) {
          throw err;
        }
        lastError = err;
        continue;
      }
      const aborted = err?.name === "AbortError";
      lastError = aborted
        ? new GoogleError("timeout", null, `model ${model}: timed out after ${timeoutMs}ms`)
        : new GoogleError("network", null, `model ${model}: ${err?.message ?? err}`);
      diagnose(`model ${model}: ${lastError.message}`);
    }
  }
  throw lastError ?? new GoogleError("network", null, "no models attempted");
}
