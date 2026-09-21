import { z } from "zod";
import { canonicalJson, canonicalText } from "../domain/canonical";
import type { FocusV1, RecommendationV1 } from "../domain/tailoringWorkspace";
import { sha256HexUtf8 } from "./hash";
import {
  canonicalRequestBytes,
  TailorQueuePayloadV2,
  type RequestHashInput,
} from "./requests";

/**
 * v1.3 queue/hash contracts (`docs/tailoring-contracts-v1.3.md` §3.1,
 * WO-1.3-A). The v2 reader, v2 hash bytes, and the `genreq:v1:`
 * identity are preserved byte-for-byte: this module only reads them,
 * never redefines them. v3 wraps the existing canonical v2 request
 * object with the immutable workflow input hash.
 */

export const TAILOR_QUEUE_SCHEMA_VERSION_V3 = "tailor-queue/v3";
export const WORKFLOW_REQUEST_INPUT_SCHEMA_VERSION = "workflow-request-input/v1";
export const GENERATION_HASH_V3_SCHEMA_VERSION = "generation-hash/v3";
export const MASTER_TEXT_PROJECTION_VERSION = "master-text/1";

/** v3 queue payload: exactly the v2 fields plus the workflow input hash. */
export const TailorQueuePayloadV3 = TailorQueuePayloadV2.omit({
  schemaVersion: true,
})
  .extend({
    schemaVersion: z.literal(TAILOR_QUEUE_SCHEMA_VERSION_V3),
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type TailorQueuePayloadV3 = z.infer<typeof TailorQueuePayloadV3>;

/** Union reader for the migration window: F keeps v2 working while adding v3. */
export const TailorQueuePayloadAnyVersion = z.discriminatedUnion("schemaVersion", [
  TailorQueuePayloadV2,
  TailorQueuePayloadV3,
]);
export type TailorQueuePayloadAnyVersion = z.infer<typeof TailorQueuePayloadAnyVersion>;

/** `recommendationHash = SHA256(canonicalJson(RecommendationV1))`. */
export function hashRecommendation(recommendations: RecommendationV1): string {
  return sha256HexUtf8(canonicalJson(recommendations));
}

export interface PhraseIdInput {
  extractionId: string;
  jdHash: string;
  startByte: number;
  endByte: number;
  text: string;
}

/** Phrase ID = SHA256 over the canonical extraction/offset/text tuple. */
export function phraseIdFor(input: PhraseIdInput): string {
  return sha256HexUtf8(
    canonicalJson({
      extractionId: input.extractionId,
      jdHash: input.jdHash,
      startByte: input.startByte,
      endByte: input.endByte,
      text: input.text,
    }),
  );
}

export interface WorkflowRequestInput {
  workspaceRevision: number;
  focus: FocusV1;
  recommendations: RecommendationV1;
  candidateSnapshotId: string;
  masterText: string;
  masterTextHash: string;
  projectionVersion: typeof MASTER_TEXT_PROJECTION_VERSION;
}

export function canonicalWorkflowRequestInputBytes(input: WorkflowRequestInput): string {
  return canonicalJson({
    schemaVersion: WORKFLOW_REQUEST_INPUT_SCHEMA_VERSION,
    workspaceRevision: input.workspaceRevision,
    focus: input.focus,
    recommendations: input.recommendations,
    candidateSnapshotId: input.candidateSnapshotId,
    masterText: input.masterText,
    masterTextHash: input.masterTextHash,
    projectionVersion: input.projectionVersion,
  });
}

/** Workflow input hash covering the frozen focus, recommendations, snapshot, and master projection. */
export function hashWorkflowRequestInput(input: WorkflowRequestInput): string {
  return sha256HexUtf8(canonicalWorkflowRequestInputBytes(input));
}

/**
 * v3 payload bytes: the existing canonical v2 request object (parsed
 * back from its canonical bytes so v2 stays the single definition)
 * wrapped with the workflow input hash. v2 bytes are untouched.
 */
export function canonicalV3PayloadBytes(v2input: RequestHashInput, inputHash: string): string {
  const base: unknown = JSON.parse(canonicalRequestBytes(v2input));
  return canonicalJson({
    schemaVersion: GENERATION_HASH_V3_SCHEMA_VERSION,
    base,
    inputHash,
  });
}

export function hashGenerationRequestV3(v2input: RequestHashInput, inputHash: string): string {
  return sha256HexUtf8(canonicalV3PayloadBytes(v2input, inputHash));
}

export interface SubmissionHashInput {
  jobId: string;
  requestId: string;
  workspaceRevision: number;
  observedRowVersion: number;
}

/** Submission identity: same id + same bytes replays; anything else conflicts. */
export function hashSubmission(input: SubmissionHashInput): string {
  return sha256HexUtf8(
    canonicalJson({
      jobId: input.jobId,
      requestId: input.requestId,
      workspaceRevision: input.workspaceRevision,
      observedRowVersion: input.observedRowVersion,
    }),
  );
}

/** Canonical master text for the frozen `master-text/1` projection (NFC/LF, NUL-stripped, trimmed). */
export function canonicalMasterText(text: string): string {
  return canonicalText(text);
}

export function hashMasterText(canonicalMaster: string): string {
  return sha256HexUtf8(canonicalMaster);
}

/**
 * Extract the UTF-8 byte range `[startByte, endByte)` from canonical JD
 * text (the `canonicalText` bytes the JD snapshot hashes). Returns null
 * when the range is out of bounds or splits a code point, so callers
 * fail closed instead of citing a replacement character.
 */
export function extractUtf8ByteRange(
  canonicalJdText: string,
  startByte: number,
  endByte: number,
): string | null {
  if (
    Number.isInteger(startByte) === false ||
    Number.isInteger(endByte) === false ||
    startByte < 0 ||
    endByte <= startByte
  ) {
    return null;
  }
  const bytes = Buffer.from(canonicalJdText, "utf8");
  if (endByte > bytes.length) {
    return null;
  }
  const slice = bytes.subarray(startByte, endByte);
  const text = slice.toString("utf8");
  if (Buffer.from(text, "utf8").equals(slice) === false) {
    return null;
  }
  return text;
}

/** Byte length of the canonical JSON encoding (SQL storage caps compare against these bytes). */
export function canonicalJsonByteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}
