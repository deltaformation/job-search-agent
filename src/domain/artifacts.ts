import { z } from "zod";
import { ResumeArtifactKind, SourceArtifactKind } from "./enums";
import { Sha256Hex } from "./fields";

/**
 * Resume/source artifact contracts. Review requires the complete
 * Markdown + DOCX + PDF set for the exact version under review.
 *
 * Path safety seam: this module validates the *shape* of stored relative
 * paths (relative, no traversal, no ambiguity). Resolving a path beneath
 * the allowlisted data root and rejecting symlinks is owned by R1-D
 * storage utilities, which must run before any filesystem access.
 */

export const REQUIRED_RESUME_ARTIFACT_KINDS: ReadonlyArray<ResumeArtifactKind> =
  ["MARKDOWN", "DOCX", "PDF"];

export function resumeArtifactSetComplete(
  kinds: readonly string[],
): boolean {
  return REQUIRED_RESUME_ARTIFACT_KINDS.every((kind) => kinds.includes(kind));
}

/** Shape-only check: relative, short, no traversal or separator ambiguity. */
export function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 1024) {
    return false;
  }
  if (value.includes("\0") || value.includes("\\")) {
    return false;
  }
  if (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\")
  ) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export const RelativeArtifactPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(isSafeRelativePath, "must be a safe relative path");
export type RelativeArtifactPath = z.infer<typeof RelativeArtifactPath>;

export const ArtifactMetadata = z
  .object({
    kind: z.union([ResumeArtifactKind, SourceArtifactKind]),
    relativePath: RelativeArtifactPath,
    mediaType: z.string().min(1).max(255),
    byteSize: z.int().min(0),
    sha256: Sha256Hex,
  })
  .strict();
export type ArtifactMetadata = z.infer<typeof ArtifactMetadata>;
