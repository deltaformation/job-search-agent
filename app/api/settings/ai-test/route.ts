import { pingOpenRouter } from "../../../../src/server/settings";
import { mutationGate, routePolicy } from "../../_lib/request";

/**
 * OpenRouter diagnostics ping. One tiny JSON prompt on the primary
 * model; returns latency, the serving model id, and status. A failed
 * ping is a 200 with `ok: false` — it is a diagnostic outcome, not a
 * route error. POST because it spends API quota.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const gate = mutationGate(request, routePolicy());
  if (gate !== null) {
    return gate;
  }
  return Response.json(await pingOpenRouter(process.env));
}
