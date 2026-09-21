import { DeclineVersionInput, declineVersion } from "../../../../../../src/server/review";
import {
  mutationGate,
  openRequestDatabase,
  parseJsonBody,
} from "../../../../_lib/request";
import { jobIdGate, reviewFailureResponse } from "../../../_lib/failures";

/**
 * Human decline. The note is mandatory — it persists on the review
 * row — and the actor is forced to the localhost human. On success the
 * version is DECLINED and tailoring rests in DECLINED: no follow-up run
 * is queued and the board never moves. The human starts the next
 * version explicitly when ready.
 */
export const dynamic = "force-dynamic";

const DeclineBody = DeclineVersionInput.omit({ jobId: true, actor: true });

interface DeclineRouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  request: Request,
  context: DeclineRouteContext,
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
  const body = await parseJsonBody(request, DeclineBody);
  if (!body.ok) {
    return body.response;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const declined = declineVersion(database.handle, {
      ...body.value,
      jobId: id,
      actor: "human",
    });
    if (!declined.ok) {
      return reviewFailureResponse(declined);
    }
    return Response.json(declined);
  } finally {
    database.release();
  }
}
