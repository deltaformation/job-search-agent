"use client";

import { canonicalJson } from "@/src/domain/canonical";
import {
  SELECTABLE_TERM_MAX_CHARS,
  TAILORING_WORKSPACE_SCHEMA_VERSION,
  type FocusV1,
  type RecommendationV1,
  type TailoringErrorBody,
  type WorkspacePut,
} from "@/src/domain/tailoringWorkspace";

/**
 * Step 2 focus-draft helpers (WO-1.3-E). Pure functions shared by the
 * production focus surface and its specs: empty drafts, binding rebase,
 * eligibility, mapping defaults, error parsing, and the pending
 * generation replay cache. The server stays authoritative for drafts —
 * browser storage only retains a submitted operation's exact bytes so
 * an uncertain network response can be replayed byte-identically.
 */

export const AUTOSAVE_DEBOUNCE_MS = 500;
export const GUIDANCE_MAX_CHARS = 1000;
export const SUMMARY_MAX_CHARS = 4000;

/** Generic guidance starters (UI copy; steering text only, never claims). */
export const GUIDANCE_STARTERS: readonly string[] = [
  "Stress measurable outcomes such as revenue, cost, latency, or scale.",
  "Stress senior scope: multi-team leadership and executive alignment.",
  "Keep bullets short, action-led, and outcome-first.",
  "Stress architecture, integrations, and production reliability.",
];

export function emptyFocus(): FocusV1 {
  return {
    schemaVersion: "tailoring-focus/v1",
    selectedPhraseIds: [],
    themeId: null,
    summaryDirection: "",
    mappings: [],
    additionalGuidance: "",
  };
}

export interface FocusBinding {
  extractionId: string | null;
  profileId: string | null;
  profileVersionId: string | null;
}

export function emptyDraft(binding: FocusBinding = {
  extractionId: null,
  profileId: null,
  profileVersionId: null,
}): WorkspacePut {
  return {
    schemaVersion: TAILORING_WORKSPACE_SCHEMA_VERSION,
    extractionId: binding.extractionId,
    profileId: binding.profileId,
    profileVersionId: binding.profileVersionId,
    requestKind: "INITIAL",
    parentVersionId: null,
    revisionNote: null,
    recommendationHash: null,
    focus: emptyFocus(),
  };
}

export function sameDraft(left: WorkspacePut, right: WorkspacePut): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function isBindingComplete(binding: FocusBinding): boolean {
  return (
    binding.extractionId !== null &&
    binding.profileId !== null &&
    binding.profileVersionId !== null
  );
}

export interface PhraseEligibility {
  selectable: boolean;
  reason: string | null;
}

/** Mirror of `validateFocusSelection` for one phrase (advisory; W decides). */
export function phraseEligibility(
  phrase: RecommendationV1["phrases"][number],
): PhraseEligibility {
  if (phrase.support !== "supported" || phrase.factIds.length === 0) {
    return {
      selectable: false,
      reason:
        phrase.support === "gap"
          ? "Evidence gap — inspectable, but it cannot be selected until profile facts back it."
          : "Uncertain support — inspectable, but only supported phrases can be selected.",
    };
  }
  if (phrase.text.length > SELECTABLE_TERM_MAX_CHARS) {
    return {
      selectable: false,
      reason: `Longer than ${SELECTABLE_TERM_MAX_CHARS} characters — it stays mapping and inspector context.`,
    };
  }
  return { selectable: true, reason: null };
}

export interface RebasedFocus {
  focus: FocusV1;
  droppedSelected: number;
  droppedMappings: number;
  resetTheme: boolean;
  resetSummary: boolean;
}

/**
 * Rebase a focus draft onto a new recommendation snapshot: free
 * guidance survives, incompatible selections/mappings are cleared, and
 * theme/summary reset to the new binding's blank slate.
 */
export function rebaseFocusForBinding(
  focus: FocusV1,
  recommendations: RecommendationV1,
): RebasedFocus {
  const phrases = new Map(recommendations.phrases.map((phrase) => [phrase.id, phrase]));
  const roles = new Map(recommendations.roles.map((role) => [role.id, role]));
  const selectedPhraseIds = focus.selectedPhraseIds.filter((phraseId) => {
    const phrase = phrases.get(phraseId);
    return phrase !== undefined && phraseEligibility(phrase).selectable;
  });
  const mappings = focus.mappings.flatMap((mapping) => {
    const role = roles.get(mapping.roleId);
    if (role === undefined || !phrases.has(mapping.phraseId)) {
      return [];
    }
    const owned = new Set(role.factIds);
    const factIds = mapping.factIds.filter((factId) => owned.has(factId));
    return factIds.length === 0 ? [] : [{ ...mapping, factIds }];
  });
  return {
    focus: {
      ...focus,
      selectedPhraseIds,
      themeId: null,
      summaryDirection: "",
      mappings,
    },
    droppedSelected: focus.selectedPhraseIds.length - selectedPhraseIds.length,
    droppedMappings: focus.mappings.length - mappings.length,
    resetTheme: focus.themeId !== null,
    resetSummary: focus.summaryDirection !== "",
  };
}

/**
 * Default mapping evidence for an assigned phrase: supporting facts
 * the role owns (overlap first), else the role's first owned fact as
 * minimal transferable steering. Null when the role owns no facts and
 * the assignment must stay disabled.
 */
export function mappingFactIdsFor(
  phraseId: string,
  roleId: string,
  recommendations: RecommendationV1,
): string[] | null {
  const phrase = recommendations.phrases.find((entry) => entry.id === phraseId);
  const role = recommendations.roles.find((entry) => entry.id === roleId);
  if (phrase === undefined || role === undefined || role.factIds.length === 0) {
    return null;
  }
  const owned = new Set(role.factIds);
  const overlap = phrase.factIds.filter((factId) => owned.has(factId));
  if (overlap.length > 0) {
    return overlap.slice(0, 20);
  }
  const first = role.factIds[0];
  return first === undefined ? null : [first];
}

export interface ParsedTailoringError {
  code: string;
  message: string;
  field?: string;
  currentWorkspaceRevision?: number;
  currentRowVersion?: number;
  action: string | null;
}

/** Tolerant ErrorBody reader over an already-parsed body: never throws. */
export function tailoringErrorFromJson(status: number, json: unknown): ParsedTailoringError {
  let parsed: TailoringErrorBody | null = null;
  if (typeof json === "object" && json !== null) {
    const body = (json as { ok?: unknown; error?: unknown })["error"];
    if (typeof body === "object" && body !== null) {
      parsed = { ok: false, error: body } as TailoringErrorBody;
    }
  }
  const error = parsed?.error as
    | {
        code?: unknown;
        message?: unknown;
        field?: unknown;
        currentWorkspaceRevision?: unknown;
        currentRowVersion?: unknown;
        action?: unknown;
      }
    | undefined;
  return {
    code: typeof error?.code === "string" ? error.code : "UNKNOWN",
    message:
      typeof error?.message === "string" && error.message !== ""
        ? error.message
        : `Request failed (${status})`,
    ...(typeof error?.field === "string" ? { field: error.field } : {}),
    ...(typeof error?.currentWorkspaceRevision === "number"
      ? { currentWorkspaceRevision: error.currentWorkspaceRevision }
      : {}),
    ...(typeof error?.currentRowVersion === "number"
      ? { currentRowVersion: error.currentRowVersion }
      : {}),
    action: typeof error?.action === "string" ? error.action : null,
  };
}

/** Tolerant ErrorBody reader: hostile/non-JSON bodies degrade, never throw. */
export async function parseTailoringError(response: Response): Promise<ParsedTailoringError> {
  let json: unknown = null;
  try {
    json = (await response.json()) as unknown;
  } catch {
    json = null;
  }
  return tailoringErrorFromJson(response.status, json);
}

export function randomOperationId(): string {
  const cryptoRef = globalThis.crypto as
    | { randomUUID?: () => string; getRandomValues?: (array: Uint8Array) => Uint8Array }
    | undefined;
  if (typeof cryptoRef?.randomUUID === "function") {
    return cryptoRef.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof cryptoRef?.getRandomValues === "function") {
    cryptoRef.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((entry) => entry.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface PendingGeneration {
  schemaVersion: "tailoring-submit/v1";
  requestId: string;
  workspaceRevision: number;
  observedRowVersion: number;
}

function pendingKey(jobId: string): string {
  return `tailor-pending-generation:${jobId}`;
}

function isPendingGeneration(value: unknown): value is PendingGeneration {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record["schemaVersion"] === "tailoring-submit/v1" &&
    typeof record["requestId"] === "string" &&
    /^[0-9a-fA-F-]{36}$/.test(record["requestId"]) &&
    typeof record["workspaceRevision"] === "number" &&
    Number.isInteger(record["workspaceRevision"]) &&
    (record["workspaceRevision"] as number) > 0 &&
    typeof record["observedRowVersion"] === "number" &&
    Number.isInteger(record["observedRowVersion"]) &&
    (record["observedRowVersion"] as number) > 0
  );
}

export function readPendingGeneration(jobId: string): PendingGeneration | null {
  try {
    const raw = window.sessionStorage.getItem(pendingKey(jobId));
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    return isPendingGeneration(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writePendingGeneration(jobId: string, body: PendingGeneration): void {
  try {
    window.sessionStorage.setItem(pendingKey(jobId), JSON.stringify(body));
  } catch {
    // Replay cache is best-effort; the in-memory body still replays this session.
  }
}

export function clearPendingGeneration(jobId: string): void {
  try {
    window.sessionStorage.removeItem(pendingKey(jobId));
  } catch {
    // Best-effort only.
  }
}
