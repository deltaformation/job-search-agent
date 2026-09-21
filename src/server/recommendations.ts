import { eq } from "drizzle-orm";
import { PROVIDER_KEY_ENV } from "../../scripts/ai-provider.mjs";
import type { DatabaseHandle } from "../db/client";
import {
  getActiveProfileVersion,
  getProfileVersion,
  listFactsByVersion,
} from "../db/candidates";
import { getTailoringJob } from "../db/tailoring";
import { jobExtractions } from "../db/schema";
import type { StoredProfilePayload } from "../domain/candidate";
import { parseStoredProfilePayload } from "../domain/candidate";
import { canonicalJson, canonicalText } from "../domain/canonical";
import { parseStoredExtraction } from "../domain/extraction";
import type { RecommendationV1 as RecommendationV1Type } from "../domain/tailoringWorkspace";
import { sha256HexUtf8 } from "../tailoring/hash";
import { buildRecommendations } from "../tailoring/recommendations";
import type { SupportEvidence } from "../tailoring/support";
import { activeProviderId } from "./settings";
import type { WorkspaceRecommendationsProvider } from "./tailoringWorkspace";

/**
 * v1.3 recommendations service (WO-1.3-D): the deterministic adapter
 * behind `GET .../tailoring/recommendations` and transaction W's
 * `WorkspaceRecommendationsProvider`, plus the Generate readiness
 * gate E's G enforces.
 *
 * Read-only throughout: no snapshots, drafts, queue rows, or reviews
 * are created (ΔQ1=0, ΔQ9=0). No provider call is ever made — the
 * provider key is only presence-checked by the readiness gate, and
 * reading/editing never consults it. Statement budget: ≤8 per
 * contracts §8 (5 worst case: job, extraction, version, active
 * version, facts).
 *
 * Binding rules mirror contracts §3: foreign/missing rows are
 * `not-found` (route: 404); owned but no-longer-active bindings are
 * `input-stale` (route: 409) on the GET path only — W rechecks
 * active ownership inside its own transaction, so the W provider
 * entry builds for any owned binding. An active binding whose
 * extraction carries no usable JD text is `jd-not-ready` (route:
 * 422); corrupt stored JSON is `storage-unavailable` (route: 503),
 * never unchecked typed data.
 */

export type RecommendationFailureError =
  | "unknown-job"
  | "not-found"
  | "input-stale"
  | "jd-not-ready"
  | "storage-unavailable";

export interface RecommendationFailure {
  error: RecommendationFailureError;
  detail: string;
  field?: string;
}

export type RecommendationResult =
  | { ok: true; recommendations: RecommendationV1Type }
  | { ok: false; failure: RecommendationFailure };

function fail(
  error: RecommendationFailureError,
  detail: string,
  extra: Partial<RecommendationFailure> = {},
): { ok: false; failure: RecommendationFailure } {
  return { ok: false, failure: { error, detail, ...extra } };
}

export interface ResolvedBinding {
  activeExtractionId: string | null;
  profileId: string;
  extractionId: string;
  canonicalJdText: string;
  jdHash: string;
  profileVersionId: string;
  profileHash: string;
  payload: StoredProfilePayload;
  approvedFacts: SupportEvidence[];
}

/**
 * Owned-row resolution shared by the GET path, the W provider, and
 * E's G (which re-verifies freshness inside its own transaction):
 * job → extraction → version → strict parses → approved facts.
 * Never checks active pointers; callers own freshness.
 */
export function resolveRecommendationBinding(
  handle: DatabaseHandle,
  input: { jobId: string; extractionId: string; profileVersionId: string },
): { ok: true; binding: ResolvedBinding } | { ok: false; failure: RecommendationFailure } {
  const job = getTailoringJob(handle, input.jobId);
  if (job === null) {
    return fail("unknown-job", `job ${input.jobId} does not exist`);
  }
  const extraction = handle.db
    .select()
    .from(jobExtractions)
    .where(eq(jobExtractions.id, input.extractionId))
    .get();
  if (extraction === undefined || extraction.jobId !== input.jobId) {
    return fail(
      "not-found",
      `extraction ${input.extractionId} does not belong to job ${input.jobId}`,
      { field: "extractionId" },
    );
  }
  const version = getProfileVersion(handle, input.profileVersionId);
  if (version === null) {
    return fail("not-found", `profile version ${input.profileVersionId} does not exist`, {
      field: "profileVersionId",
    });
  }
  let envelope: ReturnType<typeof parseStoredExtraction>;
  try {
    envelope = parseStoredExtraction(JSON.parse(extraction.extractedJson) as unknown);
  } catch {
    return fail(
      "storage-unavailable",
      `stored extraction ${input.extractionId} failed strict validation; inspect the row, do not trust it`,
      { field: "extractionId" },
    );
  }
  const canonicalJdText = canonicalText(envelope.fields.descriptionText ?? "");
  if (canonicalJdText === "") {
    return fail(
      "jd-not-ready",
      `extraction ${input.extractionId} carries no job description text`,
      { field: "extractionId" },
    );
  }
  let payload: StoredProfilePayload;
  try {
    payload = parseStoredProfilePayload(JSON.parse(version.payloadJson) as unknown);
  } catch {
    return fail(
      "storage-unavailable",
      `stored profile version ${input.profileVersionId} failed strict validation; inspect the row, do not trust it`,
      { field: "profileVersionId" },
    );
  }
  const approvedFacts = listFactsByVersion(handle, version.id)
    .filter((fact) => fact.verification === "APPROVED")
    .map((fact) => ({
      factId: fact.factId,
      statement: fact.statement,
      evidenceJson: fact.evidenceJson,
    }));
  return {
    ok: true,
    binding: {
      activeExtractionId: job.activeExtractionId,
      profileId: version.profileId,
      extractionId: input.extractionId,
      canonicalJdText,
      jdHash: sha256HexUtf8(canonicalJdText),
      profileVersionId: version.id,
      profileHash: sha256HexUtf8(canonicalJson(payload)),
      payload,
      approvedFacts,
    },
  };
}

function buildBinding(binding: ResolvedBinding): RecommendationResult {
  try {
    return {
      ok: true,
      recommendations: buildRecommendations({
        extractionId: binding.extractionId,
        canonicalJdText: binding.canonicalJdText,
        jdHash: binding.jdHash,
        profileVersionId: binding.profileVersionId,
        profileHash: binding.profileHash,
        payload: binding.payload,
        approvedFacts: binding.approvedFacts,
      }),
    };
  } catch (error: unknown) {
    return fail(
      "storage-unavailable",
      `built recommendations failed strict validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * GET-path recommendations: owned rows, active binding, then the
 * deterministic build. A profile version with zero approved facts
 * still builds — every phrase honestly reads gap/uncertain with an
 * empty preset — because support evaluation is total; Generate
 * readiness (below) is the gate that requires evidence.
 */
export function getRecommendations(
  handle: DatabaseHandle,
  input: { jobId: string; extractionId: string; profileVersionId: string },
): RecommendationResult {
  const resolved = resolveRecommendationBinding(handle, input);
  if (!resolved.ok) {
    return resolved;
  }
  const binding = resolved.binding;
  if (binding.activeExtractionId !== binding.extractionId) {
    return fail("input-stale", "binding extraction is no longer the job's active extraction", {
      field: "extractionId",
    });
  }
  const active = getActiveProfileVersion(handle, binding.profileId);
  if (active === null || active.id !== binding.profileVersionId) {
    return fail("input-stale", "binding profile version is no longer active", {
      field: "profileVersionId",
    });
  }
  return buildBinding(binding);
}

/**
 * Transaction W's recommendation provider: builds for any owned
 * binding without active checks — W rechecks active ownership
 * inside its own transaction before the CAS. Unbuildable bindings
 * (missing JD) report `extraction-not-ready` so empty drafts stay
 * saveable with honest null snapshots while selection-carrying
 * saves fail closed; corrupt storage stays a 503-class failure.
 */
export const workspaceRecommendationsProvider: WorkspaceRecommendationsProvider = {
  getRecommendations(handle, input) {
    const resolved = resolveRecommendationBinding(handle, input);
    if (!resolved.ok) {
      if (resolved.failure.error === "storage-unavailable") {
        return { ok: false, error: "storage-unavailable", detail: resolved.failure.detail };
      }
      return { ok: false, error: "extraction-not-ready", detail: resolved.failure.detail };
    }
    const built = buildBinding(resolved.binding);
    if (!built.ok) {
      return { ok: false, error: "storage-unavailable", detail: built.failure.detail };
    }
    return { ok: true, recommendations: built.recommendations };
  },
};

export type ReadinessFailureError =
  | "unknown-job"
  | "profile-not-ready"
  | "jd-not-ready"
  | "provider-not-ready"
  | "storage-unavailable";

export interface ReadinessFailure {
  error: ReadinessFailureError;
  detail: string;
}

export type ReadinessResult =
  | { ok: true }
  | { ok: false; failure: ReadinessFailure };

/**
 * Generate readiness (WO-1.3-D computes, WO-1.3-E enforces in G):
 * the bound profile version exists with at least one approved fact,
 * the bound extraction carries JD text, and the active provider has
 * a configured key. Precedence is profile → JD → provider. Read-only
 * (ΔQ1=0); the key check is presence-only over `env` and never logs
 * or transmits the secret. Missing provider blocks only Generate —
 * reading, editing, and saving never consult readiness.
 */
export function getTailoringReadiness(
  handle: DatabaseHandle,
  jobId: string,
  env: Record<string, string | undefined>,
  binding: { extractionId: string | null; profileVersionId: string | null },
): ReadinessResult {
  const job = getTailoringJob(handle, jobId);
  if (job === null) {
    return { ok: false, failure: { error: "unknown-job", detail: `job ${jobId} does not exist` } };
  }
  if (binding.profileVersionId === null) {
    return {
      ok: false,
      failure: { error: "profile-not-ready", detail: "no profile version is bound" },
    };
  }
  const version = getProfileVersion(handle, binding.profileVersionId);
  if (version === null) {
    return {
      ok: false,
      failure: {
        error: "profile-not-ready",
        detail: `profile version ${binding.profileVersionId} does not exist`,
      },
    };
  }
  const approvedCount = listFactsByVersion(handle, version.id).filter(
    (fact) => fact.verification === "APPROVED",
  ).length;
  if (approvedCount === 0) {
    return {
      ok: false,
      failure: {
        error: "profile-not-ready",
        detail: `profile version ${binding.profileVersionId} has no approved facts`,
      },
    };
  }
  if (binding.extractionId === null) {
    return {
      ok: false,
      failure: { error: "jd-not-ready", detail: "no extraction is bound" },
    };
  }
  const extraction = handle.db
    .select()
    .from(jobExtractions)
    .where(eq(jobExtractions.id, binding.extractionId))
    .get();
  if (extraction === undefined || extraction.jobId !== jobId) {
    return {
      ok: false,
      failure: {
        error: "jd-not-ready",
        detail: `extraction ${binding.extractionId} does not belong to job ${jobId}`,
      },
    };
  }
  let description: string | null;
  try {
    description = parseStoredExtraction(JSON.parse(extraction.extractedJson) as unknown).fields
      .descriptionText;
  } catch {
    return {
      ok: false,
      failure: {
        error: "storage-unavailable",
        detail: `stored extraction ${binding.extractionId} failed strict validation; inspect the row, do not trust it`,
      },
    };
  }
  if (canonicalText(description ?? "") === "") {
    return {
      ok: false,
      failure: {
        error: "jd-not-ready",
        detail: `extraction ${binding.extractionId} carries no job description text`,
      },
    };
  }
  const provider = activeProviderId(env);
  const keyName = PROVIDER_KEY_ENV[provider] as string;
  if ((env[keyName]?.trim() ?? "") === "") {
    return {
      ok: false,
      failure: {
        error: "provider-not-ready",
        detail: `active provider ${provider} has no configured key`,
      },
    };
  }
  return { ok: true };
}
