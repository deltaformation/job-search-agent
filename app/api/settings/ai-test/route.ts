import {
  AiTestInput,
  activeProviderId,
  pingProvider,
} from "../../../../src/server/settings";
import { jsonError, mutationGate, routePolicy } from "../../_lib/request";

/**
 * AI provider diagnostics ping. One tiny JSON prompt on the selected
 * (or active) provider's primary model; returns latency, the serving
 * model id, and status. A failed ping is a 200 with `ok: false` — it
 * is a diagnostic outcome, not a route error. POST because it spends
 * API quota. An empty body pings the active provider.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const gate = mutationGate(request, routePolicy());
  if (gate !== null) {
    return gate;
  }
  const raw = await request.text();
  if (raw.trim() === "") {
    return Response.json(
      await pingProvider(activeProviderId(process.env), process.env),
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return jsonError(400, "malformed JSON body");
  }
  // The UI always sends `{}` at minimum; `{}` selects the active provider.
  const parsed = AiTestInput.safeParse(data);
  if (!parsed.success) {
    return jsonError(
      400,
      "invalid request",
      parsed.error.issues[0]?.message ?? "schema mismatch",
    );
  }
  const provider = parsed.data.provider ?? activeProviderId(process.env);
  return Response.json(await pingProvider(provider, process.env));
}
