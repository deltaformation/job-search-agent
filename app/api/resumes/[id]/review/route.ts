import { resolveDataRoot } from "../../../../../src/security/data-root";
import { getResumeReviewView } from "../../../../../src/server/review";
import { jsonError, openRequestDatabase, readGate } from "../../../_lib/request";
import { entityIdGate } from "../../../jobs/_lib/failures";

/**
 * Side-by-side review projection for one resume version: requirements
 * with evidence, explicit gaps, claim-level fact citations, the change
 * summary, artifact handles, and the available actions. Read-only.
 */
export const dynamic = "force-dynamic";

interface ReviewRouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: Request,
  context: ReviewRouteContext,
): Promise<Response> {
  const gate = readGate(request);
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  const idGate = entityIdGate(id, "resume version id");
  if (idGate !== null) {
    return idGate;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  // G: pass the artifacts root so the workflowReview extension can
  // read + verify the exact canonical markdown. A misconfigured
  // root degrades the extension to "unchecked", never 500: the v1
  // view still serves.
  let artifactsDir: string | undefined;
  try {
    artifactsDir = resolveDataRoot(process.env).artifactsDir;
  } catch {
    artifactsDir = undefined;
  }
  try {
    const view = getResumeReviewView(database.handle, id, { artifactsDir });
    if (view === null) {
      return jsonError(404, "resume version not found");
    }
    return Response.json(view);
  } finally {
    database.release();
  }
}
