import { z } from "zod";
import {
  ModelSwitchInput,
  SettingsError,
  resolveEnvFilePath,
  switchModels,
} from "../../../../src/server/settings";
import {
  jsonError,
  mutationGate,
  parseJsonBody,
  routePolicy,
} from "../../_lib/request";

/**
 * Model switcher. Upserts `OPENROUTER_MODEL` / `OPENROUTER_FALLBACK_MODEL`
 * in `.env.local` (comments and other keys preserved); the new chain
 * applies on app restart. Never reads or writes the API key.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const gate = mutationGate(request, routePolicy());
  if (gate !== null) {
    return gate;
  }
  const parsed = await parseJsonBody(request, ModelSwitchInput as z.ZodType<unknown>);
  if (!parsed.ok) {
    return parsed.response;
  }
  try {
    return Response.json(switchModels(resolveEnvFilePath(process.env), parsed.value));
  } catch (error: unknown) {
    if (error instanceof SettingsError) {
      return jsonError(500, "model switch failed", error.message);
    }
    throw error;
  }
}
