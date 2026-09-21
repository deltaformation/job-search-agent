import { listVersionSummaries } from "@/src/server/tailoringWorkspace";
import {
  openTailoringDatabase,
  tailoringJson,
  tailoringPathId,
  tailoringReadGate,
  workspaceFailureResponse,
} from "@/app/api/_lib/tailoring";

/**
 * v1.3 version history API (WO-1.3-B): newest-first pages of
 * version summaries keyed by (created_at, id), at most 4
 * statements per page, without artifact bodies. Malformed
 * cursors/limits are 400; unknown jobs are 404; corrupt stored
 * review state or timestamps fail safe (503).
 */

interface VersionsRouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: VersionsRouteContext) {
  const gate = tailoringReadGate(request, process.env);
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  const idCheck = tailoringPathId(id);
  if (!idCheck.ok) {
    return idCheck.response;
  }
  const db = openTailoringDatabase(process.env);
  if (!db.ok) {
    return db.response;
  }
  try {
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const rawLimit = url.searchParams.get("limit");
    const result = listVersionSummaries(db.handle, id, {
      ...(cursor === undefined ? {} : { cursor }),
      ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
    });
    if (!result.ok) {
      return workspaceFailureResponse(result.failure);
    }
    return tailoringJson(200, {
      ok: true,
      versions: result.versions,
      nextCursor: result.nextCursor,
    });
  } finally {
    db.close();
  }
}
