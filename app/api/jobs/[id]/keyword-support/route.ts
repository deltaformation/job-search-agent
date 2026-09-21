import {
  getActiveProfileVersion,
  getDefaultProfile,
  getJobDescriptionPointer,
  getProfile,
  listFactsByVersion,
} from "../../../../../src/db/candidates";
import { extractAtsKeywords } from "../../../../../src/domain/atsKeywords";
import {
  KEYWORD_SUPPORT_POLICY_VERSION,
  evaluateKeywordSupport,
} from "../../../../../src/tailoring/support";
import {
  jsonError,
  openRequestDatabase,
  readGate,
} from "../../../_lib/request";
import { jobIdGate } from "../../_lib/failures";

/**
 * Pre-generation keyword support (WO-1.2-E, E4/E5). Ranked JD
 * suggestions with source excerpts plus per-profile support state
 * (supported/uncertain/gap with contributing fact ids) evaluated
 * locally against the profile's APPROVED facts — no provider calls.
 * `profileId` selects the profile (default when omitted); support is
 * re-evaluated per profile so switching profiles updates badges
 * without touching the user's selections or directives. Read-only.
 */
export const dynamic = "force-dynamic";

interface KeywordSupportRouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: Request,
  context: KeywordSupportRouteContext,
): Promise<Response> {
  const gate = readGate(request);
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  const idGate = jobIdGate(id);
  if (idGate !== null) {
    return idGate;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const pointer = getJobDescriptionPointer(database.handle, id);
    if (pointer === null) {
      return jsonError(404, "job not found");
    }
    const description = pointer.descriptionText?.trim() ?? "";
    if (pointer.activeExtractionId === null || description === "") {
      return Response.json({
        jobId: id,
        profileId: null,
        profileDisplayName: null,
        evaluated: false,
        reason: "This job has no extracted description text yet.",
        policyVersion: KEYWORD_SUPPORT_POLICY_VERSION,
        suggestions: [],
      });
    }
    const suggestions = extractAtsKeywords(pointer.descriptionText as string);
    const profileIdParam = new URL(request.url).searchParams.get("profileId")?.trim() || null;
    const profile =
      profileIdParam === null
        ? getDefaultProfile(database.handle)
        : getProfile(database.handle, profileIdParam);
    if (profileIdParam !== null && profile === null) {
      return jsonError(400, "unknown career profile", `profile '${profileIdParam}' does not exist`);
    }
    if (profile === null) {
      return Response.json({
        jobId: id,
        profileId: null,
        profileDisplayName: null,
        evaluated: false,
        reason: "No career profile exists yet — support is unknown until one is created.",
        policyVersion: KEYWORD_SUPPORT_POLICY_VERSION,
        suggestions: suggestions.map((entry) => ({ ...entry, support: null })),
      });
    }
    const activeVersion = getActiveProfileVersion(database.handle, profile.id);
    if (activeVersion === null) {
      return Response.json({
        jobId: id,
        profileId: profile.id,
        profileDisplayName: profile.displayName,
        evaluated: false,
        reason: `Career profile '${profile.displayName}' has no active master version — support is unknown until one is activated.`,
        policyVersion: KEYWORD_SUPPORT_POLICY_VERSION,
        suggestions: suggestions.map((entry) => ({ ...entry, support: null })),
      });
    }
    const evidence = listFactsByVersion(database.handle, activeVersion.id)
      .filter((fact) => fact.verification === "APPROVED")
      .map((fact) => ({
        factId: fact.factId,
        statement: fact.statement,
        evidenceJson: fact.evidenceJson,
      }));
    const supportByKeyword = new Map(
      evaluateKeywordSupport(
        suggestions.map((entry) => entry.keyword),
        evidence,
      ).map((entry) => [entry.keyword, { status: entry.status, factIds: entry.factIds }]),
    );
    return Response.json({
      jobId: id,
      profileId: profile.id,
      profileDisplayName: profile.displayName,
      evaluated: true,
      reason: null,
      policyVersion: KEYWORD_SUPPORT_POLICY_VERSION,
      suggestions: suggestions.map((entry) => ({
        ...entry,
        support: supportByKeyword.get(entry.keyword) ?? null,
      })),
    });
  } finally {
    database.release();
  }
}
