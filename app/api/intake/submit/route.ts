import { z } from "zod";
import {
  IntakeError,
  submitIntakeBatch,
} from "../../../../src/server/intake";
import {
  jsonError,
  mutationGate,
  openRequestDatabase,
  parseJsonBody,
} from "../../_lib/request";

/**
 * Enqueue a pasted batch: validate, persist batch/items, and create one
 * SCRAPE work item per fresh URL. One URL's failure never blocks its
 * batch siblings; per-line outcomes carry the detail.
 */
export const dynamic = "force-dynamic";

const SubmitBody = z
  .object({ lines: z.array(z.string().max(8192)).max(500) })
  .strict();

export async function POST(request: Request): Promise<Response> {
  const gate = mutationGate(request);
  if (gate !== null) {
    return gate;
  }
  const body = await parseJsonBody(request, SubmitBody);
  if (!body.ok) {
    return body.response;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const result = await submitIntakeBatch({
      handle: database.handle,
      lines: body.value.lines,
    });
    return Response.json(result);
  } catch (error: unknown) {
    if (error instanceof IntakeError) {
      return jsonError(400, "batch rejected", error.message);
    }
    throw error;
  } finally {
    database.release();
  }
}
