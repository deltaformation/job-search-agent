import { createHash } from "node:crypto";
import {
  ArtifactMetadata,
  REQUIRED_RESUME_ARTIFACT_KINDS,
  resumeArtifactSetComplete,
} from "../domain/artifacts";
import { DOCX_MEDIA_TYPE } from "./docx";
import { PDF_MEDIA_TYPE } from "./pdf";

/**
 * Resume artifact metadata (port of the `compile_html_to_pdf` naming and
 * hashing tail, extended to the Markdown + DOCX + PDF set).
 *
 * File bytes are hashed here; publishing bytes to the artifact store
 * (temp-file protocol, reservation locks, database rows) belongs to R4-E
 * orchestration. Naming mirrors the oracle: `v{version}_{hash8}.{ext}`
 * beneath one directory per job. The job key must be a UUID (as in the
 * oracle) so artifact paths can never be steered by hostile input.
 */

export const MARKDOWN_MEDIA_TYPE = "text/markdown; charset=utf-8";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

export function normalizeJobKey(jobKey: string): string {
  const lowered = jobKey.trim().toLowerCase();
  if (!UUID_PATTERN.test(lowered)) {
    throw new Error("Invalid job key for resume artifacts: expected a UUID.");
  }
  return lowered;
}

/** Reserve the `v{version}_{hash8}` stem (oracle naming, validated). */
export function reserveArtifactStem(versionNumber: number, contentHash: string): string {
  if (!Number.isInteger(versionNumber) || versionNumber < 1) {
    throw new Error("Invalid version number for resume artifacts.");
  }
  if (!CONTENT_HASH_PATTERN.test(contentHash)) {
    throw new Error("Invalid content hash for resume artifacts.");
  }
  return `v${versionNumber}_${contentHash.slice(0, 8)}`;
}

export function sha256HexBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ArtifactInputs {
  jobKey: string;
  versionNumber: number;
  contentHash: string;
  markdown: Buffer;
  docx: Buffer;
  pdf: Buffer;
}

export interface ArtifactSet {
  stem: string;
  records: ArtifactMetadata[];
}

/** Describe the immutable Markdown/DOCX/PDF set for one resume version. */
export function describeArtifacts(input: ArtifactInputs): ArtifactSet {
  const jobKey = normalizeJobKey(input.jobKey);
  const stem = reserveArtifactStem(input.versionNumber, input.contentHash);
  const records = [
    { kind: "MARKDOWN", extension: "md", mediaType: MARKDOWN_MEDIA_TYPE, bytes: input.markdown },
    { kind: "DOCX", extension: "docx", mediaType: DOCX_MEDIA_TYPE, bytes: input.docx },
    { kind: "PDF", extension: "pdf", mediaType: PDF_MEDIA_TYPE, bytes: input.pdf },
  ].map((entry) =>
    ArtifactMetadata.parse({
      kind: entry.kind,
      relativePath: `resumes/${jobKey}/${stem}.${entry.extension}`,
      mediaType: entry.mediaType,
      byteSize: entry.bytes.length,
      sha256: sha256HexBytes(entry.bytes),
    }),
  );
  if (!resumeArtifactSetComplete(records.map((record) => record.kind))) {
    throw new Error("Resume artifact set is incomplete.");
  }
  void REQUIRED_RESUME_ARTIFACT_KINDS;
  return { stem, records };
}
