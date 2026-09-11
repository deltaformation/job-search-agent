import {
  CorrectJobInput,
  correctJob,
} from "../../../../../src/server/workflow";
import {
  mutationGate,
  openRequestDatabase,
  parseJsonBody,
} from "../../../_lib/request";
import { commandFailureResponse, jobIdGate } from "../../_lib/failures";

/**
 * Explicit corrections and reopens: any transition outside the ordinary
 * graph, always with a mandatory human note. Entering TAILORED stays
 * approval-only — corrections cannot bypass the R4-F gate.
 */
export const dynamic = "force-dynamic";

const CorrectBody = CorrectJobInput.omit({ jobId: true, actor: true });

interface CorrectRouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  request: Request,
  context: CorrectRouteContext,
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
  const body = await parseJsonBody(request, CorrectBody);
  if (!body.ok) {
    return body.response;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const corrected = correctJob(database.handle, {
      ...body.value,
      jobId: id,
      actor: "human",
    });
    if (!corrected.ok) {
      return commandFailureResponse(corrected);
    }
    return Response.json(corrected);
  } finally {
    database.release();
  }
}
