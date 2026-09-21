import { z } from "zod";
import { eq } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client";
import {
  getActiveProfileVersion,
  getDefaultProfile,
  getJobDescriptionPointer,
  getProfile,
} from "../db/candidates";
import { getGenerationRequest, getLiveGenerationRequest } from "../db/generation";
import { generationRequests, type GenerationRequest } from "../db/schema/generation";
import { workItems } from "../db/schema/queue";
import { resumeVersions } from "../db/schema/resumes";
import { casJobTailoringState, getTailoringJob, type TailoringJobRow } from "../db/tailoring";
import { withTransaction } from "../db/transactions";
import { newId, utcNow } from "../db/utils";
import { canonicalJson } from "../domain/canonical";
import { EntityId, RequiredNote, RowVersion } from "../domain/fields";
import type { TailoringState } from "../domain/enums";
import { planTailoringTransition } from "../domain/tailoring";
import {
  canonicalKeywordSet,
  generationRequestIdentity,
  hashGenerationRequest,
  SteeringSnapshotV1,
  TailorQueuePayloadV2,
  TAILOR_QUEUE_SCHEMA_VERSION_V2,
  type GenerationRequestKind,
} from "../tailoring/requests";
import {
  getOrCreateCandidateSnapshot,
  getOrCreateJdSnapshot,
} from "./candidates";
import {
  submitGeneration,
  type SubmitGenerationInput,
  type SubmitGenerationResult,
} from "./generations";

/**
 * Explicit generation commands (WO-1.2-D, R-ADR-015/R-ADR-017). Nothing
 * here runs on scrape, on a timer, or on any implicit trigger: every
 * run starts with one validated human command that pref lights profile
 * readiness, evidence, JD content, and provider availability BEFORE
 * any queue row exists. Zero phantom queuing is structural — the only
 * TAILOR insert path is this module, and the database additionally
 * refuses legacy v1 payloads.
 */

export const RequestGenerationInput = z
  .object({
    jobId: EntityId,
    observedRowVersion: RowVersion,
    actor: z.literal("human"),
    /** Profile id or slug; the default profile when omitted. */
    profileId: z.string().trim().min(1).max(64).optional(),
    selectedKeywords: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
    directives: z.string().trim().max(1000).optional(),
    /** Revision runs only: the human note, bound end-to-end as steering. */
    revisionNote: RequiredNote.optional(),
    /** New-version / revision runs: the parent resume version. */
    parentVersionId: EntityId.optional(),
    /**
     * Client operation identity for double-submit dedupe (one id per
     * submission draft). Same id resubmitted returns the existing
     * request; omitted mints a fresh identity (a deliberate new run).
     */
    requestId: EntityId.optional(),
    now: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type RequestGenerationInput = z.infer<typeof RequestGenerationInput>;

export type RequestGenerationError =
  | "unknown-job"
  | "request-forbidden"
  | "profile-not-found"
  | "profile-not-ready"
  | "extraction-missing"
  | "empty-jd"
  | "forged-selection"
  | "provider-unavailable"
  | "snapshot-corrupt"
  | "parent-mismatch"
  | "idempotency-mismatch"
  | "generation-busy"
  | "conflict";

export type RequestGenerationResult =
  | {
      ok: true;
      requestId: string;
      requestKind: GenerationRequestKind;
      workItemId: string;
      deduped: boolean;
      requeued: boolean;
      newRowVersion: number;
    }
  | { ok: false; error: RequestGenerationError; detail: string; action: string };

export interface RequestGenerationDeps {
  /** Provider availability probe; defaults to the worker env config. */
  providerAvailable?: () => boolean;
  now?: () => string;
}

/**
 * Default provider probe: the worker executes TAILOR runs only when
 * TAILOR_PROVIDER_ARGV configures a provider command, so preflight
 * reports unavailable (BLOCKED) under the same condition instead of
 * queuing work that cannot run. Malformed config also reads
 * unavailable — the worker refuses to boot on it, so no run could
 * proceed. Tests inject the deterministic seam via deps.
 */
export function defaultProviderAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["TAILOR_PROVIDER_ARGV"];
  if (raw === undefined || raw.trim() === "") {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((entry): entry is string => typeof entry === "string" && entry !== "")
    );
  } catch {
    return false;
  }
}

function fail(
  error: RequestGenerationError,
  detail: string,
  action: string,
): RequestGenerationResult {
  return { ok: false, error, detail, action };
}

/**
 * Submit one explicit generation command. Two legs share this entry
 * (WO-1.3-E): inputs carrying `workspaceRevision` run v1.3
 * transaction G over the exact stored focus and caller operation ID
 * (never the default-profile fallback); legacy guidance inputs keep
 * the v1 path until H's cutover. Both legs enforce the same
 * duplicate discipline: byte-identical resubmits replay as-is with
 * zero writes (even when FAILED — recovery is explicit retry, never
 * requeue-on-replay), changed bytes under a reused operation ID fail
 * 409 IDEMPOTENCY_MISMATCH, and a fresh ID while a run is live
 * fails 409 GENERATION_BUSY. Neither leg forks a second version.
 */
export function requestGeneration(
  handle: DatabaseHandle,
  rawInput: SubmitGenerationInput,
  deps?: RequestGenerationDeps,
): SubmitGenerationResult;
export function requestGeneration(
  handle: DatabaseHandle,
  rawInput: unknown,
  deps?: RequestGenerationDeps,
): RequestGenerationResult;
export function requestGeneration(
  handle: DatabaseHandle,
  rawInput: unknown,
  deps: RequestGenerationDeps = {},
): RequestGenerationResult | SubmitGenerationResult {
  if (
    typeof rawInput === "object" &&
    rawInput !== null &&
    "workspaceRevision" in rawInput
  ) {
    return submitGeneration(handle, rawInput, { env: process.env });
  }
  const input = RequestGenerationInput.parse(rawInput);
  const now = input.now ?? deps.now?.() ?? utcNow();
  const providerAvailable = deps.providerAvailable ?? (() => defaultProviderAvailable());

  return withTransaction(handle.sqlite, () => {
    const job = getTailoringJob(handle, input.jobId);
    if (job === null) {
      return fail("unknown-job", `job ${input.jobId} does not exist`, "Reload the board.");
    }

    // Double-submit by identity: byte-identical resubmits replay
    // the existing run as-is with zero writes; changed bytes under
    // a reused operation ID fail closed — never a second version.
    if (input.requestId !== undefined) {
      const byIdentity = getGenerationRequest(handle, input.requestId);
      if (byIdentity !== null) {
        return replayLegacySubmission(byIdentity, job, input);
      }
    }
    // One live run per job: a concurrent duplicate (any identity)
    // Concurrent duplicate: a fresh operation ID while a run is
    // live fails closed instead of attaching — the caller replays
    // the live run's own operation ID or waits for it. Deliberate
    // later requests (after completion) always create new rows.
    const live = getLiveGenerationRequest(handle, input.jobId);
    if (live !== null) {
      return fail(
        "generation-busy",
        `request ${live.id} is already live for this job; replay its own operation ID or wait for it`,
        "Wait for the live run, then resubmit with a fresh operation ID.",
      );
    }

    const requestId = input.requestId ?? newId();
    const identity = generationRequestIdentity(requestId);

    const kind = deriveRequestKind(handle, job, input);
    if (!kind.ok) {
      return kind.failure;
    }

    // State gate: explicit commands may start from preparation,
    // terminal, decided, or failed states — never from a live run
    // (covered above) and never for rejected jobs.
    const move = planGenerationMove(job.tailoringState, kind.value, job.status);
    if (move === null) {
      return fail(
        "request-forbidden",
        `cannot start generation while tailoring is ${job.tailoringState}`,
        job.tailoringState === "RUNNING" || job.tailoringState === "PENDING"
          ? "Wait for the queued run to finish, then start a new version."
          : "Reload the job; its state changed.",
      );
    }

    // Profile readiness (D8): the selected profile must exist with an
    // active master version. Failures write nothing and enqueue nothing.
    const profile =
      input.profileId === undefined
        ? getDefaultProfile(handle)
        : getProfile(handle, input.profileId);
    if (input.profileId !== undefined && profile === null) {
      return fail(
        "profile-not-found",
        `career profile '${input.profileId}' does not exist`,
        "Pick another profile for this run.",
      );
    }
    if (profile === null) {
      return fail(
        "profile-not-ready",
        "no default career profile exists",
        "Open Settings → Candidate Profile and create a profile, then onboard and activate its master.",
      );
    }
    const activeVersion = getActiveProfileVersion(handle, profile.id);
    if (activeVersion === null) {
      return fail(
        "profile-not-ready",
        `career profile '${profile.displayName}' has no active master version`,
        `Open Settings → Candidate Profile → ${profile.displayName}, onboard a master, and activate it explicitly.`,
      );
    }

    // Evidence (D1/D8): an active extraction with canonical JD text.
    const pointer = getJobDescriptionPointer(handle, input.jobId);
    if (pointer === null || pointer.activeExtractionId === null) {
      return fail(
        "extraction-missing",
        "job has no extracted description yet",
        "Wait for the scrape to finish extracting the description, then start generation.",
      );
    }
    if (pointer.descriptionText === null || pointer.descriptionText.trim() === "") {
      return fail(
        "empty-jd",
        "job description is empty",
        "Correct the job with a non-empty description, then start generation.",
      );
    }

    // Selection validation (WO-1.2-E, E3): every selected keyword must
    // occur in the bound JD (case-insensitive). Forged (non-JD)
    // selections fail closed before anything is written — requested
    // emphasis can only steer toward extracted content, never smuggle
    // terms past the evidence fence.
    const keywords = canonicalKeywordSet(input.selectedKeywords);
    const jdLower = pointer.descriptionText.toLowerCase();
    const forged = keywords.find((term) => !jdLower.includes(term.toLowerCase()));
    if (forged !== undefined) {
      return fail(
        "forged-selection",
        `selected keyword '${forged.slice(0, 80)}' does not occur in the job description`,
        "Pick keyword suggestions from the job description.",
      );
    }

    // Provider availability: no provider, no queue row. Jobs that can
    // rest BLOCKED do; decided jobs keep their state with an error.
    if (!providerAvailable()) {
      const blocked = tryMoveBlocked(handle, job, now);
      return fail(
        "provider-unavailable",
        "no tailoring provider is configured",
        blocked
          ? "Configure TAILOR_PROVIDER_ARGV for the worker, then retry from BLOCKED."
          : "Configure TAILOR_PROVIDER_ARGV for the worker, then start generation again.",
      );
    }

    // Parent binding for new-version / revision runs.
    if (input.parentVersionId !== undefined) {
      const parent = handle.db
        .select({ id: resumeVersions.id, jobId: resumeVersions.jobId })
        .from(resumeVersions)
        .where(eq(resumeVersions.id, input.parentVersionId))
        .get();
      if (parent === undefined || parent.jobId !== input.jobId) {
        return fail(
          "parent-mismatch",
          `parent version '${input.parentVersionId}' does not belong to job ${input.jobId}`,
          "Reload the job; its versions changed.",
        );
      }
    }

    // Pin the exact JD snapshot (idempotent get-or-create) and verify
    // the pinned profile version snapshots cleanly before committing.
    const jd = getOrCreateJdSnapshot(handle, {
      jobId: input.jobId,
      extractionId: pointer.activeExtractionId,
      jdText: pointer.descriptionText,
    });
    if (!jd.ok) {
      if (jd.error === "empty-jd") {
        return fail("empty-jd", jd.detail, "Correct the job with a non-empty description.");
      }
      const detail =
        jd.error === "job-not-found"
          ? `job '${input.jobId}' does not exist`
          : `extraction '${pointer.activeExtractionId}' is not usable for this job`;
      return fail("extraction-missing", detail, "Wait for extraction, then retry.");
    }
    const candidate = getOrCreateCandidateSnapshot(handle, {
      profileVersionId: activeVersion.id,
    });
    if (!candidate.ok) {
      return fail(
        "snapshot-corrupt",
        candidate.error === "version-not-found"
          ? `profile version '${activeVersion.id}' is no longer available`
          : candidate.detail,
        "Re-activate the profile master in Settings, then retry.",
      );
    }

    const steering = SteeringSnapshotV1.parse({
      schemaVersion: "generation-steering/v1",
      profileId: profile.id,
      profileVersionId: activeVersion.id,
      profileName: profile.name,
      profileDisplayName: profile.displayName,
      executiveNarrative: profile.executiveNarrative,
      targetTitles: profile.workPreferences?.targetTitles ?? [],
      targetLocations: profile.workPreferences?.targetLocations ?? [],
      careerKeywords: profile.workPreferences?.careerKeywords ?? [],
      workMode: profile.workPreferences?.workMode ?? [],
      workAuthorization: profile.workPreferences?.workAuthorization ?? [],
      sponsorshipRequired: profile.workPreferences?.sponsorshipRequired ?? null,
      willingToRelocate: profile.workPreferences?.willingToRelocate ?? null,
      yearsOfExperience: profile.workPreferences?.yearsOfExperience ?? null,
    });
    const payloadHash = hashGenerationRequest({
      requestIdentity: identity,
      jobId: input.jobId,
      extractionId: pointer.activeExtractionId,
      profileId: profile.id,
      profileVersionId: activeVersion.id,
      jdSnapshotId: jd.snapshotId,
      parentVersionId: input.parentVersionId ?? null,
      requestKind: kind.value,
      steeringSnapshot: steering,
      selectedKeywords: keywords,
      directivesText: input.directives ?? null,
      revisionNote: input.revisionNote ?? null,
    });

    // Fence first: the row_version CAS runs before any row is written,
    // so a stale client gets a clean conflict with zero side effects.
    const fenced = casJobTailoringState(handle, {
      jobId: input.jobId,
      rowVersion: input.observedRowVersion,
      tailoringState: move,
      reasonCode: null,
      now,
    });
    if (!fenced) {
      return fail(
        "conflict",
        `stale client: observed row_version ${input.observedRowVersion}`,
        "Reload the job and resubmit.",
      );
    }

    const workItemId = newId();
    const payload = TailorQueuePayloadV2.parse({
      schemaVersion: TAILOR_QUEUE_SCHEMA_VERSION_V2,
      generationRequestId: requestId,
      jobId: input.jobId,
      extractionId: pointer.activeExtractionId,
      profileId: profile.id,
      profileVersionId: activeVersion.id,
      jdSnapshotId: jd.snapshotId,
      ...(input.parentVersionId === undefined ? {} : { parentVersionId: input.parentVersionId }),
      payloadHash,
    });
    // Queue item first: the request row's work_item_id references it.
    handle.db
      .insert(workItems)
      .values({
        id: workItemId,
        kind: "TAILOR",
        idempotencyKey: identity,
        jobId: input.jobId,
        payloadJson: canonicalJson(payload),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    handle.db.insert(generationRequests).values({
        id: requestId,
        requestIdentity: identity,
        jobId: input.jobId,
        extractionId: pointer.activeExtractionId,
        profileId: profile.id,
        profileVersionId: activeVersion.id,
        jdSnapshotId: jd.snapshotId,
        parentVersionId: input.parentVersionId ?? null,
        requestKind: kind.value,
        steeringSnapshotJson: canonicalJson(steering),
        selectedKeywordsJson: canonicalJson(keywords),
        directivesText: input.directives ?? null,
        revisionNote: input.revisionNote ?? null,
        payloadHash,
        workItemId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return {
      ok: true,
      requestId,
      requestKind: kind.value,
      workItemId,
      deduped: false,
      requeued: false,
      newRowVersion: job.rowVersion + 1,
    };
  });
}

function deriveRequestKind(
  handle: DatabaseHandle,
  job: TailoringJobRow,
  input: z.infer<typeof RequestGenerationInput>,
):
  | { ok: true; value: GenerationRequestKind }
  | { ok: false; failure: RequestGenerationResult } {
  if (input.revisionNote !== undefined) {
    if (input.parentVersionId === undefined) {
      return {
        ok: false,
        failure: fail(
          "parent-mismatch",
          "revision runs require a parent version",
          "Request the revision from the version under review.",
        ),
      };
    }
    if (input.parentVersionId !== job.activeResumeVersionId) {
      return {
        ok: false,
        failure: fail(
          "parent-mismatch",
          "revision runs must parent the active version",
          "Reload the job; its active version changed.",
        ),
      };
    }
    return { ok: true, value: "REVISION" };
  }
  if (input.parentVersionId !== undefined) {
    if (input.parentVersionId !== job.activeResumeVersionId) {
      return {
        ok: false,
        failure: fail(
          "parent-mismatch",
          "new versions must parent the active version",
          "Reload the job; its active version changed.",
        ),
      };
    }
    return { ok: true, value: "NEW_VERSION" };
  }
  // No parent: INITIAL on a versionless job, otherwise the caller must
  // name the active version explicitly (no silent fork).
  if (jobHasVersions(handle, input.jobId)) {
    return {
      ok: false,
      failure: fail(
        "parent-mismatch",
        "this job already has resume versions; name the active parent",
        "Reload the job and start the new version from the active one.",
      ),
    };
  }
  return { ok: true, value: "INITIAL" };
}

/** Target queued state for a kind, or null when the current state forbids starting. */
function planGenerationMove(
  current: string,
  kind: GenerationRequestKind,
  jobStatus: string,
): "PENDING" | "REVISION_REQUESTED" | null {
  if (jobStatus === "REJECTED") {
    return null;
  }
  if (kind === "REVISION") {
    return current === "AWAITING_REVIEW" ? "REVISION_REQUESTED" : null;
  }
  switch (current) {
    case "READY":
    case "BLOCKED":
    case "FAILED":
    case "AWAITING_REVIEW":
    case "APPROVED":
    case "DECLINED":
      return "PENDING";
    default:
      return null;
  }
}

/** Best-effort BLOCKED rest for provider-missing preflight (READY/PENDING only). */
function tryMoveBlocked(
  handle: DatabaseHandle,
  job: { id: string; tailoringState: string; rowVersion: number },
  now: string,
): boolean {
  const planned = planTailoringTransition(job.tailoringState as TailoringState, {
    to: "BLOCKED",
    reasonCode: "PROVIDER_UNAVAILABLE",
  });
  if (!planned.ok) {
    return false;
  }
  return casJobTailoringState(handle, {
    jobId: job.id,
    rowVersion: job.rowVersion,
    tailoringState: "BLOCKED",
    reasonCode: "PROVIDER_UNAVAILABLE",
    now,
  });
}

/**
 * Same-identity resubmission (WO-1.3-E): byte-identical submissions
 * replay the existing run as-is with zero writes — even when FAILED
 * (recovery is explicit retry, never requeue-on-replay). Any byte
 * difference under the reused operation ID — different job,
 * profile, keywords, directives, or note — fails closed with 409
 * IDEMPOTENCY_MISMATCH. The frozen v2 request hash is recomputed
 * from the stored immutable fields plus the incoming guidance, so
 * the comparison needs no new columns.
 */
function replayLegacySubmission(
  existing: GenerationRequest,
  job: TailoringJobRow,
  input: RequestGenerationInput,
): RequestGenerationResult {
  if (existing.jobId !== input.jobId) {
    return fail(
      "idempotency-mismatch",
      `operation ${existing.id} belongs to another job`,
      "Mint a fresh operation ID for this job.",
    );
  }
  if (input.profileId !== undefined && input.profileId !== existing.profileId) {
    return fail(
      "idempotency-mismatch",
      `operation ${existing.id} was submitted for another profile`,
      "Mint a fresh operation ID to submit different bytes.",
    );
  }
  let steering: z.infer<typeof SteeringSnapshotV1>;
  try {
    steering = SteeringSnapshotV1.parse(JSON.parse(existing.steeringSnapshotJson) as unknown);
  } catch {
    return fail(
      "snapshot-corrupt",
      `request ${existing.id} carries unreadable steering; inspect the row, do not trust it`,
      "Mint a fresh operation ID and resubmit.",
    );
  }
  const resubmitted = hashGenerationRequest({
    requestIdentity: existing.requestIdentity,
    jobId: existing.jobId,
    extractionId: existing.extractionId,
    profileId: existing.profileId,
    profileVersionId: existing.profileVersionId,
    jdSnapshotId: existing.jdSnapshotId,
    parentVersionId: existing.parentVersionId,
    requestKind: existing.requestKind as GenerationRequestKind,
    steeringSnapshot: steering,
    selectedKeywords: canonicalKeywordSet(input.selectedKeywords),
    directivesText: input.directives ?? null,
    revisionNote: input.revisionNote ?? null,
  });
  if (resubmitted !== existing.payloadHash) {
    return fail(
      "idempotency-mismatch",
      `operation ${existing.id} was already submitted with different bytes`,
      "Mint a fresh operation ID to submit different bytes.",
    );
  }
  if (existing.workItemId === null) {
    return fail(
      "snapshot-corrupt",
      `request ${existing.id} has no queue row; inspect the row, do not trust it`,
      "Mint a fresh operation ID and resubmit.",
    );
  }
  return {
    ok: true,
    requestId: existing.id,
    requestKind: existing.requestKind as GenerationRequestKind,
    workItemId: existing.workItemId,
    deduped: true,
    requeued: false,
    newRowVersion: job.rowVersion,
  };
}

function jobHasVersions(handle: DatabaseHandle, jobId: string): boolean {
  const row = handle.db
    .select({ id: resumeVersions.id })
    .from(resumeVersions)
    .where(eq(resumeVersions.jobId, jobId))
    .limit(1)
    .get();
  return row !== undefined;
}
