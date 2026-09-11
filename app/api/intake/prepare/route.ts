import { z } from "zod";
import {
  IntakeError,
  prepareIntakeLines,
} from "../../../../src/server/intake";
import { jsonError, mutationGate, parseJsonBody } from "../../_lib/request";

/**
 * Validate pasted lines without persisting anything. Runs the same
 * classification submit runs (canonicalize, DNS preflight, in-batch
 * duplicates) so the preview matches the enqueue result; cross-batch
 * duplicates only resolve at submit time.
 */
export const dynamic = "force-dynamic";

const PrepareBody = z
  .object({ lines: z.array(z.string().max(8192)).max(500) })
  .strict();

export async function POST(request: Request): Promise<Response> {
  const gate = mutationGate(request);
  if (gate !== null) {
    return gate;
  }
  const body = await parseJsonBody(request, PrepareBody);
  if (!body.ok) {
    return body.response;
  }
  try {
    const results = await prepareIntakeLines({ lines: body.value.lines });
    return Response.json({ results });
  } catch (error: unknown) {
    if (error instanceof IntakeError) {
      return jsonError(400, "batch rejected", error.message);
    }
    throw error;
  }
}
