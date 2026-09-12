import { RequestRevisionInput, requestRevision } from "../../../../../../src/server/review";
import {
  mutationGate,
  openRequestDatabase,
  parseJsonBody,
} from "../../../../_lib/request";
import { jobIdGate, reviewFailureResponse } from "../../../_lib/failures";

/**
 * Human revision request. The note is mandatory — it persists on the
 * review row — and the actor is forced to the localhost human. On
 * success the version is REVISION_REQUESTED and a follow-up TAILOR run
 * is queued, which will attach the new child version.
 */
export const dynamic = "force-dynamic";

const ReviseBody = RequestRevisionInput.omit({ jobId: true, actor: true });

interface ReviseRouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  request: Request,
  context: ReviseRouteContext,
): Promise<Response> {
  const gate = mutationGate(request);
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  const idGate = jobIdGate(id);
  if (idGate !== null) {
    return idGate;
  }
  const body = await parseJsonBody(request, ReviseBody);
  if (!body.ok) {
    return body.response;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const revised = requestRevision(database.handle, {
      ...body.value,
      jobId: id,
      actor: "human",
    });
    if (!revised.ok) {
      return reviewFailureResponse(revised);
    }
    return Response.json(revised);
  } finally {
    database.release();
  }
}
