import { canonicalJson } from "../domain/canonical";
import {
  PreparationFailure,
  type PreparationFailure as PreparationFailureType,
  type PreparationStage,
} from "../domain/step2";
import {
  TAILORING_FAILURE_SCHEMA_VERSION,
  TailoringFailure,
  type TailoringFailure as TailoringFailureType,
  type TailoringStage,
} from "../domain/tailoringWorkspace";
import type { OrchestrationFailureReason } from "./orchestrate";

/**
 * v1.3 worker failure mapping (WO-1.3-F, contracts §5). Every mapping
 * in this module branches on actual codes — provider reasons, spawn
 * errnos, orchestration reasons — never on prose. UI copy lives
 * client-side; this module only produces the schema-validated
 * `Failure` value the worker persists inside `error_detail`.
 */

export type FailureCode = TailoringFailureType["code"];
export type FailureAction = TailoringFailureType["action"];
export type LaunchSubcode = NonNullable<TailoringFailureType["launchSubcode"]>;

/**
 * Default action per code, following the §5 table within the domain
 * action vocabulary (`edit_focus | edit_profile | open_settings |
 * retry | wait`): RATE_LIMIT waits for quota (`wait`), and LEASE_LOST
 * waits for recovery (`wait`) since no `none` action exists.
 */
export const FAILURE_ACTIONS: Record<FailureCode, FailureAction> = {
  CONFIGURATION: "open_settings",
  AUTHENTICATION: "open_settings",
  RATE_LIMIT: "wait",
  NETWORK: "retry",
  PROVIDER_TIMEOUT: "retry",
  LOCAL_LAUNCH: "open_settings",
  INVALID_RESPONSE: "retry",
  INPUT_STALE: "edit_focus",
  PROFILE_UNAVAILABLE: "edit_profile",
  CLAIM_VALIDATION: "edit_focus",
  RENDER_FAILED: "retry",
  PUBLISH_FAILED: "retry",
  LEASE_LOST: "wait",
  INTERNAL: "retry",
};

/**
 * Codes transaction R may retry. Only the three terminal-input codes
 * are excluded: everything else is either transient (auto-retried by
 * the dispatcher until the budget is spent) or explicitly retryable
 * after human repair. INTERNAL stays retryable as the explicit escape
 * hatch — a repeated INTERNAL is a bug report, not a dead end.
 */
const RETRYABLE_FAILURE_CODES: ReadonlySet<FailureCode> = new Set([
  "CONFIGURATION",
  "AUTHENTICATION",
  "RATE_LIMIT",
  "NETWORK",
  "PROVIDER_TIMEOUT",
  "LOCAL_LAUNCH",
  "INVALID_RESPONSE",
  "RENDER_FAILED",
  "PUBLISH_FAILED",
  "LEASE_LOST",
  "INTERNAL",
]);

/**
 * Explicit-only codes (contracts §6): the dispatcher must NOT
 * auto-retry these — the handler returns them with `terminal: true`
 * so the item finishes FAILED immediately and only an explicit
 * human retry (transaction R, after repair where applicable) can
 * requeue. LEASE_LOST is neither: a lease-losing worker persists
 * nothing and recovery decides.
 */
const EXPLICIT_ONLY_FAILURE_CODES: ReadonlySet<FailureCode> = new Set([
  "INPUT_STALE",
  "PROFILE_UNAVAILABLE",
  "CONFIGURATION",
  "AUTHENTICATION",
  "LOCAL_LAUNCH",
  "CLAIM_VALIDATION",
]);

const FailureCodeOnly = TailoringFailure.pick({ code: true });

export function isFailureCode(value: unknown): value is FailureCode {
  return FailureCodeOnly.safeParse({ code: value }).success;
}

export function isRetryableFailureCode(code: FailureCode): boolean {
  return RETRYABLE_FAILURE_CODES.has(code);
}

export function isExplicitOnlyFailureCode(code: FailureCode): boolean {
  return EXPLICIT_ONLY_FAILURE_CODES.has(code);
}

/**
 * Orchestration/provider reason → Failure code. STALE_INPUT (claim or
 * proposal validation the run cannot fix) becomes CLAIM_VALIDATION;
 * the generic PROVIDER_UNAVAILABLE bucket (unclassified exits, our own
 * envelope bugs, non-ProviderError throws) becomes INTERNAL.
 */
export function failureCodeForReason(reason: OrchestrationFailureReason): FailureCode {
  switch (reason) {
    case "AUTHENTICATION":
      return "AUTHENTICATION";
    case "RATE_LIMIT":
      return "RATE_LIMIT";
    case "TIMEOUT":
      return "PROVIDER_TIMEOUT";
    case "NETWORK":
      return "NETWORK";
    case "INVALID_RESPONSE":
      return "INVALID_RESPONSE";
    case "LOCAL_LAUNCH":
      return "LOCAL_LAUNCH";
    case "STALE_INPUT":
      return "CLAIM_VALIDATION";
    case "RENDER_FAILED":
      return "RENDER_FAILED";
    case "PROVIDER_UNAVAILABLE":
      return "INTERNAL";
  }
}

/**
 * Spawn errno → launch subcode. Only the actual captured errno feeds
 * this: ENOENT/EACCES surface verbatim, any other real errno becomes
 * OTHER, and a missing errno stays null (never invented).
 */
export function launchSubcodeForSpawnCode(spawnCode: string | null): LaunchSubcode | null {
  if (spawnCode === null || spawnCode === "") {
    return null;
  }
  if (spawnCode === "ENOENT" || spawnCode === "EACCES") {
    return spawnCode;
  }
  return "OTHER";
}

export interface FailureContext {
  stage: TailoringStage | null;
  occurredAt: string;
  retryAfterSeconds?: number | null;
  launchSubcode?: LaunchSubcode | null;
}

export function buildFailure(code: FailureCode, context: FailureContext): TailoringFailureType {
  return TailoringFailure.parse({
    code,
    stage: context.stage,
    occurredAt: context.occurredAt,
    action: FAILURE_ACTIONS[code],
    retryAfterSeconds: context.retryAfterSeconds ?? null,
    launchSubcode: context.launchSubcode ?? null,
  });
}

/** Versioned `error_detail` envelope persisted on attempts and requests. */
export function encodeFailureDetail(failure: TailoringFailureType): string {
  return canonicalJson({
    schemaVersion: TAILORING_FAILURE_SCHEMA_VERSION,
    failure,
  });
}

/**
 * Strict versioned adapter (§6): returns the Failure only when the
 * envelope carries exactly `tailoring-failure/v1` with a valid
 * Failure. Legacy text, corrupt JSON, and schema drift all return
 * null so callers degrade to INTERNAL — never to persisted values.
 */
export function parseFailureDetail(detail: string | null): TailoringFailureType | null {
  if (detail === null || detail === "") {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(detail) as unknown;
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return null;
  }
  const record = decoded as Record<string, unknown>;
  if (record["schemaVersion"] !== TAILORING_FAILURE_SCHEMA_VERSION) {
    return null;
  }
  const parsed = TailoringFailure.safeParse(record["failure"]);
  return parsed.success ? parsed.data : null;
}

/**
 * Synthetic INTERNAL for legacy/corrupt error evidence. `occurredAt`
 * must come from a persisted timestamp (attempt finishedAt or server
 * now on the read path) — never from the legacy text.
 */
export function legacyFailure(occurredAt: string): TailoringFailureType {
  return buildFailure("INTERNAL", { stage: null, occurredAt });
}

/**
 * Retry classification for transaction R from a stored attempt's
 * `error_code`. Versioned v1.3 codes decide directly; legacy codes
 * map through this allowlist. Unknown legacy text degrades to
 * retryable INTERNAL (the explicit escape hatch), never to a block.
 */
export function retryableFromErrorCode(errorCode: string | null): {
  code: FailureCode;
  retryable: boolean;
} {
  if (errorCode !== null && isFailureCode(errorCode)) {
    return { code: errorCode, retryable: isRetryableFailureCode(errorCode) };
  }
  switch (errorCode) {
    case "STALE_INPUT":
      return { code: "CLAIM_VALIDATION", retryable: false };
    case "TIMEOUT":
      return { code: "PROVIDER_TIMEOUT", retryable: true };
    case "LEASE_EXPIRED":
      return { code: "LEASE_LOST", retryable: true };
    case "REQUEST_NOT_FOUND":
    case "JOB_MISMATCH":
    case "BINDING_MISMATCH":
    case "HASH_MISMATCH":
    case "GUIDANCE_MISMATCH":
    case "MISSING_STEERING":
    case "CORRUPT":
      return { code: "INPUT_STALE", retryable: false };
    case "PROFILE_REQUIRED":
      return { code: "PROFILE_UNAVAILABLE", retryable: false };
    default:
      return { code: "INTERNAL", retryable: true };
  }
}

/**
 * Step 2 preparation failures (WO-1.3-S2-B, S2-A §1.7): same code
 * and action vocabulary as generation, staged on the preparation
 * lifecycle, persisted in the same versioned envelope. Preparation
 * never emits CLAIM_VALIDATION or RENDER_FAILED (no renderer runs;
 * proposal defects are INVALID_RESPONSE).
 */
export type PreparationFailureCode = PreparationFailureType["code"];

export function isPreparationRetryableFailureCode(
  code: PreparationFailureCode,
): boolean {
  return code !== "INPUT_STALE" && code !== "PROFILE_UNAVAILABLE";
}

export interface PreparationFailureContext {
  stage: PreparationStage | null;
  occurredAt: string;
  retryAfterSeconds?: number | null;
  launchSubcode?: LaunchSubcode | null;
}

export function buildPreparationFailure(
  code: PreparationFailureCode,
  context: PreparationFailureContext,
): PreparationFailureType {
  return PreparationFailure.parse({
    code,
    stage: context.stage,
    occurredAt: context.occurredAt,
    action: FAILURE_ACTIONS[code],
    retryAfterSeconds: context.retryAfterSeconds ?? null,
    launchSubcode: context.launchSubcode ?? null,
  });
}

export function encodePreparationFailureDetail(
  failure: PreparationFailureType,
): string {
  return canonicalJson({
    schemaVersion: TAILORING_FAILURE_SCHEMA_VERSION,
    failure,
  });
}

export function parsePreparationFailureDetail(
  detail: string | null,
): PreparationFailureType | null {
  if (detail === null || detail === "") {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(detail) as unknown;
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return null;
  }
  const record = decoded as Record<string, unknown>;
  if (record["schemaVersion"] !== TAILORING_FAILURE_SCHEMA_VERSION) {
    return null;
  }
  const parsed = PreparationFailure.safeParse(record["failure"]);
  return parsed.success ? parsed.data : null;
}

/**
 * Lease-loss signal. Stage emission and the renewal timer raise this
 * (never a terminal persist): the handler converts it into a
 * write-free LEASE_LOST return so a stale worker can never publish,
 * fail, or emit after its lease died.
 */
export class LeaseLostError extends Error {
  constructor() {
    super("lease lost");
    this.name = "LeaseLostError";
  }
}
