import {
  ReorderJobInput,
  reorderJob,
} from "../../../../../src/server/workflow";
import {
  mutationGate,
  openRequestDatabase,
  parseJsonBody,
} from "../../../_lib/request";
import { commandFailureResponse, jobIdGate } from "../../_lib/failures";

/** Rank-only reorder inside the current column (same-column drag). */
export const dynamic = "force-dynamic";

const ReorderBody = ReorderJobInput.omit({ jobId: true, actor: true });

interface ReorderRouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  request: Request,
  context: ReorderRouteContext,
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
  const body = await parseJsonBody(request, ReorderBody);
  if (!body.ok) {
    return body.response;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const reordered = reorderJob(database.handle, {
      ...body.value,
      jobId: id,
      actor: "human",
    });
    if (!reordered.ok) {
      return commandFailureResponse(reordered);
    }
    return Response.json(reordered);
  } finally {
    database.release();
  }
}
