import { resolveDataRoot } from "../../../../../../src/security/data-root";
import { ApproveResumeInput, approveResume } from "../../../../../../src/server/review";
import {
  mutationGate,
  openRequestDatabase,
  parseJsonBody,
} from "../../../../_lib/request";
import { jobIdGate, reviewFailureResponse } from "../../../_lib/failures";

/**
 * Exact-version human approval. The actor is always the localhost human —
 * forced server-side, never read from the client. On success the version
 * is APPROVED, the review binds the re-hashed artifact digests, and the
 * card has moved to TAILORED with a human-attributed event.
 */
export const dynamic = "force-dynamic";

const ApproveBody = ApproveResumeInput.omit({ jobId: true, actor: true });

interface ApproveRouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  request: Request,
  context: ApproveRouteContext,
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
  const body = await parseJsonBody(request, ApproveBody);
  if (!body.ok) {
    return body.response;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    let artifactsDir: string;
    try {
      artifactsDir = resolveDataRoot(process.env).artifactsDir;
    } catch {
      return reviewFailureResponse({
        ok: false,
        error: "artifact-unreadable",
        detail: "artifact store is misconfigured",
      });
    }
    const approved = approveResume(
      database.handle,
      { ...body.value, jobId: id, actor: "human" },
      { artifactsDir },
    );
    if (!approved.ok) {
      return reviewFailureResponse(approved);
    }
    return Response.json(approved);
  } finally {
    database.release();
  }
}
