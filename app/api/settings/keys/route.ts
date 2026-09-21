import { z } from "zod";
import {
  ProviderKeysInput,
  SettingsError,
  resolveEnvFilePath,
  saveProviderKey,
} from "../../../../src/server/settings";
import {
  jsonError,
  mutationGate,
  parseJsonBody,
  routePolicy,
} from "../../_lib/request";

/**
 * Provider API key writer (WO-1.2-G). Masked write-only add/replace/
 * remove in `.env.local` only — secrets never reach SQLite, logs,
 * responses, or backups. A blank `key` retains the stored key (no-op);
 * removal requires explicit `remove: true`. The response carries
 * presence and fingerprint only, never the key. Applies on restart.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const gate = mutationGate(request, routePolicy());
  if (gate !== null) {
    return gate;
  }
  const parsed = await parseJsonBody(request, ProviderKeysInput as z.ZodType<unknown>);
  if (!parsed.ok) {
    return parsed.response;
  }
  try {
    return Response.json(saveProviderKey(resolveEnvFilePath(process.env), parsed.value));
  } catch (error: unknown) {
    if (error instanceof SettingsError) {
      return jsonError(400, "key update failed", error.message);
    }
    throw error;
  }
}
