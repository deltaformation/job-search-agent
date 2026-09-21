import {
  masterResumePath,
  resyncMasterResume,
  resolveCandidateDir,
} from "../../../../src/server/settings";
import {
  jsonError,
  mutationGate,
  openRequestDatabase,
  routePolicy,
} from "../../_lib/request";
import { resolveRoutePaths } from "../../_lib/data-mgmt";

/**
 * Candidate profile re-sync. Imports `data/candidate/master-resume.json`
 * as a new immutable profile version (no-op when the canonical payload
 * hash matches the latest version) and activates it. Never edits or
 * deletes versions.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const gate = mutationGate(request, routePolicy());
  if (gate !== null) {
    return gate;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const { paths } = resolveRoutePaths(process.env);
    const result = resyncMasterResume(
      database.handle,
      masterResumePath(resolveCandidateDir(process.env)),
      { sourcesDir: paths.sourcesDir },
    );
    if (!result.ok) {
      const status = result.error === "activation-failed" ? 500 : 400;
      return jsonError(status, "re-sync failed", result.detail ?? result.error);
    }
    return Response.json(result);
  } finally {
    database.release();
  }
}
