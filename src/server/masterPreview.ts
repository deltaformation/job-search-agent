import type { DatabaseHandle } from "../db/client";
import {
  getActiveProfileVersion,
  getProfile,
  getDefaultProfile,
  getProfileVersionByNumber,
} from "../db/candidates";
import { parseStoredProfilePayload, type StoredProfilePayload } from "../domain/candidate";

/**
 * Master resume preview resolution (WO-1.2-F, F2). The preview page
 * accepts explicit profile/version identity so links stay pinned to
 * the selected master even after later default switches or master
 * updates; omitting identity keeps the legacy default/active target.
 * Every lookup resolves through database rows — unknown identity is
 * an honest error, never a silent fallback to another profile.
 */

export interface MasterPreviewSelection {
  profileId?: string;
  version?: number;
}

export interface MasterPreviewSuccess {
  ok: true;
  profileId: string;
  profileName: string;
  profileDisplayName: string;
  versionId: string;
  version: number;
  syncedAt: string;
  payload: StoredProfilePayload;
}

export type MasterPreviewErrorCode =
  | "no-profiles"
  | "unknown-profile"
  | "no-active-version"
  | "unknown-version"
  | "unparseable-payload";

export interface MasterPreviewFailure {
  ok: false;
  error: MasterPreviewErrorCode;
  detail: string;
}

export type MasterPreviewResult = MasterPreviewSuccess | MasterPreviewFailure;

export function resolveMasterPreview(
  handle: DatabaseHandle,
  selection: MasterPreviewSelection,
): MasterPreviewResult {
  const profile =
    selection.profileId === undefined
      ? getDefaultProfile(handle)
      : getProfile(handle, selection.profileId);
  if (selection.profileId !== undefined && profile === null) {
    return {
      ok: false,
      error: "unknown-profile",
      detail: `Career profile '${selection.profileId}' does not exist.`,
    };
  }
  if (profile === null) {
    return {
      ok: false,
      error: "no-profiles",
      detail: "No career profiles exist yet.",
    };
  }
  const versionRow =
    selection.version === undefined
      ? getActiveProfileVersion(handle, profile.id)
      : getProfileVersionByNumber(handle, selection.version, profile.id);
  if (selection.version !== undefined && versionRow === null) {
    return {
      ok: false,
      error: "unknown-version",
      detail: `Career profile '${profile.displayName}' has no master version ${selection.version}.`,
    };
  }
  if (versionRow === null) {
    return {
      ok: false,
      error: "no-active-version",
      detail: `Career profile '${profile.displayName}' has no active master version.`,
    };
  }
  let payload: StoredProfilePayload;
  try {
    payload = parseStoredProfilePayload(JSON.parse(versionRow.payloadJson) as unknown);
  } catch {
    return {
      ok: false,
      error: "unparseable-payload",
      detail: `Master version ${versionRow.version} of '${profile.displayName}' cannot be read.`,
    };
  }
  return {
    ok: true,
    profileId: profile.id,
    profileName: profile.name,
    profileDisplayName: profile.displayName,
    versionId: versionRow.id,
    version: versionRow.version,
    syncedAt: versionRow.createdAt,
    payload,
  };
}
