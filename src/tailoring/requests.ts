import { z } from "zod";
import { canonicalJson } from "../domain/canonical";
import { EntityId } from "../domain/fields";
import { sha256HexUtf8 } from "./hash";

/**
 * Explicit generation request contracts (WO-1.2-D, R-ADR-017). Pure:
 * schemas plus the canonical request bytes that `payload_hash` covers.
 * The worker recomputes the hash from the stored row and refuses the
 * item on mismatch, so a tampered or half-written request can never
 * execute.
 */

export const TAILOR_QUEUE_SCHEMA_VERSION_V2 = "tailor-queue/v2";
export const STEERING_SNAPSHOT_SCHEMA_VERSION = "generation-steering/v1";
export const GENERATION_REQUEST_KINDS = ["INITIAL", "NEW_VERSION", "REVISION"] as const;
export type GenerationRequestKind = (typeof GENERATION_REQUEST_KINDS)[number];

/** Frozen steering recorded per request (narrative + work-preference metadata). */
export const SteeringSnapshotV1 = z
  .object({
    schemaVersion: z.literal(STEERING_SNAPSHOT_SCHEMA_VERSION),
    profileId: z.string().min(1),
    profileVersionId: z.string().min(1),
    profileName: z.string().min(1),
    profileDisplayName: z.string().min(1),
    executiveNarrative: z.string().nullable(),
    targetTitles: z.array(z.string()),
    targetLocations: z.array(z.string()),
    careerKeywords: z.array(z.string()),
    workMode: z.array(z.string()),
    workAuthorization: z.array(z.string()),
    sponsorshipRequired: z.boolean().nullable(),
    willingToRelocate: z.boolean().nullable(),
    yearsOfExperience: z.number().nullable(),
  })
  .strict();
export type SteeringSnapshotV1 = z.infer<typeof SteeringSnapshotV1>;

/**
 * Queue payload v2. Carries the request id plus the pinned bindings
 * the worker revalidates (row existence, hash match, same-job
 * ownership, active extraction). `profileId`/`extractionId` are
 * denormalized for fencing without a second lookup.
 */
export const TailorQueuePayloadV2 = z
  .object({
    schemaVersion: z.literal(TAILOR_QUEUE_SCHEMA_VERSION_V2),
    generationRequestId: EntityId,
    jobId: z.string().min(1),
    extractionId: z.string().min(1),
    profileId: z.string().min(1),
    profileVersionId: z.string().min(1),
    jdSnapshotId: z.string().min(1),
    parentVersionId: z.string().min(1).optional(),
    payloadHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type TailorQueuePayloadV2 = z.infer<typeof TailorQueuePayloadV2>;

/** Idempotency identity: double-submit reuses it, deliberate reruns mint a new one. */
export function generationRequestIdentity(requestId: string): string {
  return `genreq:v1:${requestId}`;
}

export interface RequestHashInput {
  requestIdentity: string;
  jobId: string;
  extractionId: string;
  profileId: string;
  profileVersionId: string;
  jdSnapshotId: string;
  parentVersionId: string | null;
  requestKind: GenerationRequestKind;
  steeringSnapshot: SteeringSnapshotV1;
  selectedKeywords: string[];
  directivesText: string | null;
  revisionNote: string | null;
}

/** Canonical request bytes hashed into `payload_hash` (and only these). */
export function canonicalRequestBytes(input: RequestHashInput): string {
  return canonicalJson({
    requestIdentity: input.requestIdentity,
    jobId: input.jobId,
    extractionId: input.extractionId,
    profileId: input.profileId,
    profileVersionId: input.profileVersionId,
    jdSnapshotId: input.jdSnapshotId,
    parentVersionId: input.parentVersionId,
    requestKind: input.requestKind,
    steeringSnapshot: input.steeringSnapshot,
    selectedKeywords: input.selectedKeywords,
    directivesText: input.directivesText,
    revisionNote: input.revisionNote,
  });
}

export function hashGenerationRequest(input: RequestHashInput): string {
  return sha256HexUtf8(canonicalRequestBytes(input));
}

/** Canonical keyword set: sorted + deduped, so chip reorder never forks identity. */
export function canonicalKeywordSet(selectedKeywords: string[] | undefined): string[] {
  if (selectedKeywords === undefined) {
    return [];
  }
  return [...new Set(selectedKeywords.map((entry) => entry.trim()).filter((entry) => entry !== ""))].sort();
}
