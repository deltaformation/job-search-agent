import { z } from "zod";
import { ProfileDisplayName, ProfileId, ProfileSlug } from "../../../../../src/domain/candidate";
import { EntityId } from "../../../../../src/domain/fields";
import { copyProfileFromVersion } from "../../../../../src/server/candidates";
import {
  jsonError,
  mutationGate,
  openRequestDatabase,
  parseJsonBody,
  routePolicy,
} from "../../../_lib/request";
import { resolveRoutePaths } from "../../../_lib/data-mgmt";

/**
 * Create a profile from an existing profile's immutable version (B6,
 * R-ADR-020). Every fact is copied to a minted id with recorded
 * provenance, verification is retained exactly, and the result is an
 * inactive draft requiring explicit activation. Never copies resumes,
 * approvals, or applications.
 */
export const dynamic = "force-dynamic";

const CopyProfileBody = z
  .object({
    sourceProfileId: ProfileId,
    sourceVersionId: EntityId.optional(),
    name: ProfileSlug,
    displayName: ProfileDisplayName,
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  const gate = mutationGate(request, routePolicy());
  if (gate !== null) {
    return gate;
  }
  const parsed = await parseJsonBody(request, CopyProfileBody);
  if (!parsed.ok) {
    return parsed.response;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const { paths } = resolveRoutePaths(process.env);
    const result = copyProfileFromVersion(
      database.handle,
      { ...parsed.value, actor: "human" },
      { sourcesDir: paths.sourcesDir },
    );
    if (!result.ok) {
      const status =
        result.error === "profile-not-found" || result.error === "version-not-found"
          ? 404
          : result.error === "name-taken"
            ? 409
            : 400;
      return jsonError(status, "profile copy failed", result.detail);
    }
    return Response.json(result, { status: 201 });
  } finally {
    database.release();
  }
}
