import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { getProfile } from "../../../../src/db/candidates";
import { ProfileId } from "../../../../src/domain/candidate";
import {
  masterResumePath,
  parseMasterResumeDocument,
  resolveCandidateDir,
  resyncMasterResume,
} from "../../../../src/server/settings";
import {
  jsonError,
  mutationGate,
  openRequestDatabase,
  parseJsonBody,
  readGate,
  routePolicy,
} from "../../_lib/request";

/**
 * Master resume document management. GET downloads the current
 * `master-resume.json`; POST replaces it with validated content and
 * immediately re-syncs it into the target profile (default when no
 * `profileId` is given). Uploaded content must parse as a profile
 * payload — invalid documents are rejected before anything is written.
 */
export const dynamic = "force-dynamic";

const MasterResumeUpload = z
  .object({
    content: z.unknown(),
    profileId: ProfileId.optional(),
  })
  .strict();

/** Uploaded master resumes stay small (local human-authored JSON). */
const MAX_UPLOAD_BYTES = 2_000_000;

export async function GET(request: Request): Promise<Response> {
  const gate = readGate(request);
  if (gate !== null) {
    return gate;
  }
  const path = masterResumePath(resolveCandidateDir(process.env));
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return jsonError(404, "no master resume saved yet");
    }
    return jsonError(500, "master resume unreadable", (error as Error).message);
  }
  return new Response(raw, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-disposition": 'attachment; filename="master-resume.json"',
    },
  });
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
    const path = masterResumePath(resolveCandidateDir(process.env));
    mkdirSync(dirname(path), { recursive: true });
    const staging = join(
      dirname(path),
      `.master-resume.${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}.tmp`,
    );
    writeFileSync(staging, serialized, "utf8");
    renameSync(staging, path);
    const result = resyncMasterResume(database.handle, path, {
      profileId: parsed.value.profileId,
    });
    if (!result.ok) {
      const status = result.error === "activation-failed" ? 500 : 400;
      return jsonError(status, "re-sync failed", result.detail ?? result.error);
    }
    return Response.json(result);
  } finally {
    database.release();
  }
}
