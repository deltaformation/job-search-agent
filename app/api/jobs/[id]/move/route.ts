import {
  MoveJobInput,
  moveJob,
  recordApplication,
} from "../../../../../src/server/workflow";
import {
  mutationGate,
  openRequestDatabase,
  parseJsonBody,
} from "../../../_lib/request";
import { commandFailureResponse, jobIdGate } from "../../_lib/failures";

/**
 * Ordinary board moves (drag/drop, status menu). The actor is always the
 * localhost human — forced server-side, never read from the client. Moves
 * into APPLIED run the Applied modal contract (timestamp required);
 * anything outside the ordinary graph must use /correct instead.
 */
export const dynamic = "force-dynamic";

const MoveBody = MoveJobInput.omit({ jobId: true, actor: true });

interface MoveRouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  request: Request,
  context: MoveRouteContext,
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
  const body = await parseJsonBody(request, MoveBody);
  if (!body.ok) {
    return body.response;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    if (body.value.to === "APPLIED") {
      if (body.value.appliedAt === undefined) {
        return Response.json(
          {
            error: "application-data-required",
            reason: "moves into APPLIED must record when the human applied",
            to: "APPLIED",
          },
          { status: 400 },
        );
      }
      const applied = recordApplication(database.handle, {
        jobId: id,
        observedRowVersion: body.value.observedRowVersion,
        actor: "human",
        appliedAt: body.value.appliedAt,
        confirmationNumber: body.value.confirmationNumber,
        rank: body.value.rank,
      });
      if (!applied.ok) {
        return commandFailureResponse(applied);
      }
      return Response.json(applied);
    }
    const moved = moveJob(database.handle, {
      ...body.value,
      jobId: id,
      actor: "human",
    });
    if (!moved.ok) {
      return commandFailureResponse(moved);
    }
    return Response.json(moved);
  } finally {
    database.release();
  }
}
