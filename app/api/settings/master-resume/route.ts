import { z } from "zod";
import { getProfile } from "../../../../src/db/candidates";
import { ProfileId } from "../../../../src/domain/candidate";
import {
  importMasterDocument,
  parseMasterResumeDocument,
  readActiveMasterSource,
} from "../../../../src/server/settings";
import {
  jsonError,
  mutationGate,
  openRequestDatabase,
  parseJsonBody,
  readGate,
  routePolicy,
} from "../../_lib/request";
import { resolveRoutePaths } from "../../_lib/data-mgmt";

/**
 * Master resume document management (R-ADR-016). GET downloads one
 * profile's active master source bytes (`?profileId=`, default when
 * absent) as recorded in `candidate_sources` — never the legacy file.
 * POST validates content, publishes it as the target profile's new
 * version source, and imports it (activating unless `activate` is
 * false). Invalid documents are rejected before anything is written;
 * any failure leaves the previous active source/version untouched.
 */
export const dynamic = "force-dynamic";

const MasterResumeUpload = z
  .object({
    content: z.unknown(),
    profileId: ProfileId.optional(),
    activate: z.boolean().optional(),
  })
  .strict();

/** Uploaded master resumes stay small (local human-authored JSON). */
const MAX_UPLOAD_BYTES = 2_000_000;

export async function GET(request: Request): Promise<Response> {
  const gate = readGate(request);
  if (gate !== null) {
    return gate;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const { searchParams } = new URL(request.url);
    const profileId = searchParams.get("profileId") ?? undefined;
    const { paths } = resolveRoutePaths(process.env);
    const result = readActiveMasterSource(database.handle, paths.sourcesDir, profileId ?? undefined);
    if (!result.ok) {
      if (result.error === "profile-not-found") {
        return jsonError(404, "profile not found", result.detail);
      }
      if (result.error === "no-master") {
        return jsonError(404, "no master resume saved yet");
      }
      if (result.error === "source-missing") {
        return jsonError(500, "master source not recorded", result.detail);
      }
      return jsonError(500, "master resume unreadable", result.detail);
    }
    return new Response(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        "content-type": result.mediaType,
        "content-disposition": 'attachment; filename="master-resume.json"',
      },
    });
  } finally {
    database.release();
  }
}

export async function POST(request: Request): Promise<Response> {
  const gate = mutationGate(request, routePolicy());
  if (gate !== null) {
    return gate;
  }
  const parsed = await parseJsonBody(request, MasterResumeUpload);
  if (!parsed.ok) {
    return parsed.response;
  }
  const validated = parseMasterResumeDocument(parsed.value.content);
  if (!validated.ok) {
    return jsonError(400, "invalid master resume", validated.detail);
  }
  const serialized = `${JSON.stringify(parsed.value.content, null, 2)}\n`;
  if (serialized.length > MAX_UPLOAD_BYTES) {
    return jsonError(413, "master resume is too large", `limit is ${MAX_UPLOAD_BYTES} bytes`);
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    if (parsed.value.profileId !== undefined && getProfile(database.handle, parsed.value.profileId) === null) {
      return jsonError(404, "profile not found", parsed.value.profileId);
    }
    const { paths } = resolveRoutePaths(process.env);
    const result = importMasterDocument(database.handle, {
      document: parsed.value.content,
      // Store the authored document verbatim (stable re-serialization);
      // normalization lives in the version payload, not the source.
      sourceBytes: Buffer.from(serialized, "utf8"),
      profileId: parsed.value.profileId,
      origin: "upload",
      sourcesDir: paths.sourcesDir,
      activate: parsed.value.activate,
    });
    if (!result.ok) {
      const status = result.error === "activation-failed" ? 500 : 400;
      const reason =
        result.detail === undefined ? result.error : `${result.error}: ${result.detail}`;
      return jsonError(status, "re-sync failed", reason);
    }
    return Response.json(result);
  } finally {
    database.release();
  }
}
