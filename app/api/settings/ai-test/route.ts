import {
  AiTestInput,
  activeProviderId,
  testProviderDraft,
} from "../../../../src/server/settings";
import { jsonError, mutationGate, routePolicy } from "../../_lib/request";

/**
 * AI provider diagnostics ping (WO-1.2-G). Tests the exact entered
 * provider/model/transient-key draft without saving anything; a blank
 * key draft reuses the stored key from the running process. A failed
 * ping is a 200 with `ok: false` — it is a diagnostic outcome, not a
 * route error — carrying a reason code and an actionable next step.
 * POST because it spends API quota. An empty body pings the active
 * provider's primary model with the stored key.
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
      await testProviderDraft({ provider: activeProviderId(process.env) }, process.env),
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
  return Response.json(await testProviderDraft(parsed.data, process.env));
}
