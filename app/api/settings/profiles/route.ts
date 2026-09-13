import { CreateCareerProfileInputV1 } from "../../../../src/domain/candidate";
import { createProfile } from "../../../../src/db/candidates";
import { listProfileSummaries } from "../../../../src/server/settings";
import {
  jsonError,
  mutationGate,
  openRequestDatabase,
  parseJsonBody,
  readGate,
  routePolicy,
} from "../../_lib/request";

/**
 * Career profile collection. GET lists summaries (identity, default
 * flag, version ledger position, approved fact count); POST creates one
 * named profile. Profile rows are steering metadata only — they never
 * carry resume claims or bypass fact citations.
 */
export const dynamic = "force-dynamic";

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
    return Response.json({ profiles: listProfileSummaries(database.handle) });
  } finally {
    database.release();
  }
}

export async function POST(request: Request): Promise<Response> {
  const gate = mutationGate(request, routePolicy());
  if (gate !== null) {
    return gate;
  }
  const parsed = await parseJsonBody(request, CreateCareerProfileInputV1);
  if (!parsed.ok) {
    return parsed.response;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const created = createProfile(database.handle, parsed.value);
    return Response.json({ profile: created }, { status: 201 });
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message.includes("UNIQUE constraint failed: candidate_profiles")
    ) {
      return jsonError(409, "profile name is already taken", parsed.value.name);
    }
    throw error;
  } finally {
    database.release();
  }
}
