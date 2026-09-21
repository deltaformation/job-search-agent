import { z } from "zod";
import { STEP2_SCHEMA_VERSIONS, WorkspacePutV2 } from "@/src/domain/step2";
import { STEP2_CORRECTION_VERSIONS, WorkspacePutV3 } from "@/src/domain/step2Correction";
import {
  TAILORING_WORKSPACE_SCHEMA_VERSION,
  WorkspacePut,
} from "@/src/domain/tailoringWorkspace";
import { workspaceRecommendationsProvider } from "@/src/server/recommendations";
import { getWorkspaceView, saveWorkspace, saveWorkspaceV2, saveWorkspaceV3 } from "@/src/server/tailoringWorkspace";
import {
  ifMatchWorkspace,
  openTailoringDatabase,
  parseCappedJsonBody,
  tailoringError,
  tailoringJson,
  tailoringMutationGate,
  tailoringPathId,
  tailoringReadGate,
  workspaceFailureResponse,
  zodInvalidRequest,
} from "@/app/api/_lib/tailoring";

/**
 * v1.3 workspace API (WO-1.3-B; v2 bodies WO-1.3-S2-C): bounded GET
 * (absent workspaces return a null body at revision 0 without
 * inserting; the reply carries the stored version's schema) and
 * revision-CAS PUT (201 creates, 200 updates, 428/400/412 gate the
 * ETag). PUT accepts v1, v2, or v3 (correction) by
 * `schemaVersion`; saving one version replaces the stored bytes
 * wholesale, never merges. All responses use the ErrorBody
 * envelope with no-store.
 */

interface WorkspaceRouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: WorkspaceRouteContext) {
  const gate = tailoringReadGate(request, process.env);
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  const idCheck = tailoringPathId(id);
  if (!idCheck.ok) {
    return idCheck.response;
  }
  const db = openTailoringDatabase(process.env);
  if (!db.ok) {
    return db.response;
  }
  try {
    const result = getWorkspaceView(db.handle, id);
    if (!result.ok) {
      return workspaceFailureResponse(result.failure);
    }
    return tailoringJson(200, { ok: true, workspace: result.value.workspace }, result.value.etag);
  } finally {
    db.close();
  }
}

export async function PUT(request: Request, context: WorkspaceRouteContext) {
  const gate = tailoringMutationGate(request, process.env);
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  const idCheck = tailoringPathId(id);
  if (!idCheck.ok) {
    return idCheck.response;
  }
  const match = ifMatchWorkspace(request, id);
  if (!match.ok) {
    return match.response;
  }
  const db = openTailoringDatabase(process.env);
  if (!db.ok) {
    return db.response;
  }
  try {
    const raw = await parseCappedJsonBody(request, z.unknown());
    if (!raw.ok) {
      return raw.response;
    }
    const schemaVersion = (raw.value as { schemaVersion?: unknown } | null)?.schemaVersion;
    const parsed =
      schemaVersion === STEP2_CORRECTION_VERSIONS.workspace
        ? WorkspacePutV3.safeParse(raw.value)
        : schemaVersion === STEP2_SCHEMA_VERSIONS.workspace
          ? WorkspacePutV2.safeParse(raw.value)
          : schemaVersion === TAILORING_WORKSPACE_SCHEMA_VERSION
            ? WorkspacePut.safeParse(raw.value)
            : null;
    if (parsed === null) {
      return tailoringError(400, "INVALID_REQUEST", "unknown workspace schemaVersion", {
        field: "schemaVersion",
      });
    }
    if (!parsed.success) {
      return zodInvalidRequest(parsed.error);
    }
    const result =
      parsed.data.schemaVersion === STEP2_CORRECTION_VERSIONS.workspace
        ? saveWorkspaceV3(db.handle, id, match.observedRevision, parsed.data, {
            recommendations: workspaceRecommendationsProvider,
          })
        : parsed.data.schemaVersion === STEP2_SCHEMA_VERSIONS.workspace
          ? saveWorkspaceV2(db.handle, id, match.observedRevision, parsed.data, {
              recommendations: workspaceRecommendationsProvider,
            })
          : saveWorkspace(db.handle, id, match.observedRevision, parsed.data, {
              recommendations: workspaceRecommendationsProvider,
            });
    if (!result.ok) {
      return workspaceFailureResponse(result.failure);
    }
    return tailoringJson(
      result.value.created ? 201 : 200,
      { ok: true, workspace: result.value.workspace },
      result.value.etag,
    );
  } finally {
    db.close();
  }
}
