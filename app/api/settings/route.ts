import { resolveDataRoot } from "../../../src/security/data-root";
import { getSettingsSnapshot } from "../../../src/server/settings";
import {
  jsonError,
  openRequestDatabase,
  readGate,
  routePolicy,
} from "../_lib/request";

/**
 * Settings snapshot for the Settings modal: model chain, OpenRouter
 * status (key fingerprint only, never the secret), active profile
 * summary, and storage stats. Read-only; mutations live under
 * `/api/settings/model`, `/api/settings/ai-test`, `/api/settings/resync`.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const gate = readGate(request, routePolicy());
  if (gate !== null) {
    return gate;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    let paths: ReturnType<typeof resolveDataRoot>;
    try {
      paths = resolveDataRoot(process.env);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return jsonError(500, "data root misconfigured", detail);
    }
    return Response.json(getSettingsSnapshot(database.handle, { paths }));
  } finally {
    database.release();
  }
}
