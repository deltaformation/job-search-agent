import { z } from "zod";
import { summarizeMasterPayload } from "../../../../../src/domain/master-preview";
import { validateMasterResumeDocument } from "../../../../../src/server/settings";
import {
  jsonError,
  mutationGate,
  parseJsonBody,
  routePolicy,
} from "../../../_lib/request";

/**
 * No-write master-resume validation for the settings review flow
 * (WO-1.2-C). Accepts exactly the documents the upload route accepts
 * and returns the normalized payload with a section summary, or
 * per-field `{path, message}` issues so the UI can highlight exact
 * controls. Nothing is staged, imported, or activated here; the
 * explicit "Review and activate" upload is a separate human action.
 */
export const dynamic = "force-dynamic";

const ParseBody = z.object({ content: z.unknown() }).strict();

/** Mirrors the upload route's size cap (local human-authored JSON). */
const MAX_UPLOAD_BYTES = 2_000_000;

export async function POST(request: Request): Promise<Response> {
  const gate = mutationGate(request, routePolicy());
  if (gate !== null) {
    return gate;
  }
  const parsed = await parseJsonBody(request, ParseBody);
  if (!parsed.ok) {
    return parsed.response;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(parsed.value.content) ?? "";
  } catch {
    return jsonError(400, "invalid master resume", "content is not serializable");
  }
  if (serialized.length > MAX_UPLOAD_BYTES) {
    return jsonError(413, "master resume is too large", `limit is ${MAX_UPLOAD_BYTES} bytes`);
  }
  const validated = validateMasterResumeDocument(parsed.value.content);
  if (!validated.ok) {
    return Response.json({ ok: false, issues: validated.issues }, { status: 422 });
  }
  return Response.json({
    ok: true,
    payload: validated.payload,
    payloadHash: validated.payloadHash,
    importVersion: validated.importVersion,
    summary: summarizeMasterPayload(validated.payload),
  });
}
