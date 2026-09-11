import { createHash } from "node:crypto";
import { z } from "zod";
import { RelativeArtifactPath } from "../domain/artifacts";
import { ReasonCode } from "../domain/enums";
import { Sha256Hex } from "../domain/fields";
import { SourceArtifactKind } from "../domain/enums";

/**
 * Fetch envelope: the R2-C → R2-D handoff contract. The fetcher produces
 * exactly one envelope per fetch attempt; R2-D extraction consumes it and
 * must reject unknown `schemaVersion` values instead of guessing.
 */

export const FETCH_ENVELOPE_VERSION = "fetch-envelope-v1";

export const FetchRedirectHop = z
  .object({ url: z.string().min(1).max(2048) })
  .strict();

export const FetchArtifactRef = z
  .object({
    kind: SourceArtifactKind,
    relativePath: RelativeArtifactPath,
    mediaType: z.string().min(1).max(255),
    byteSize: z.number().int().min(0),
    sha256: Sha256Hex,
  })
  .strict();
export type FetchArtifactRef = z.infer<typeof FetchArtifactRef>;

export const FetchEnvelopeV1 = z
  .object({
    schemaVersion: z.literal(FETCH_ENVELOPE_VERSION),
    submittedUrl: z.string().min(1).max(2048),
    canonicalUrl: z.string().min(1).max(2048),
    canonicalKey: z.string().min(1).max(2064),
    finalUrl: z.string().min(1).max(2048),
    httpStatus: z.number().int().min(100).max(599),
    redirectChain: z.array(FetchRedirectHop).max(8),
    blocked: z
      .object({
        reasonCode: ReasonCode,
        detail: z.string().min(1).max(2000),
      })
      .strict()
      .nullable(),
    artifacts: z.array(FetchArtifactRef).max(3),
    fetchedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type FetchEnvelopeV1 = z.infer<typeof FetchEnvelopeV1>;

/**
 * Deterministic content hash of an envelope: the queue `outputHash` for a
 * successful fetch. Key order is fixed by construction (not by JSON key
 * sorting) so equal fetches hash equally on every runtime.
 */
export function hashFetchEnvelope(envelope: FetchEnvelopeV1): string {
  const canonical = JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    canonicalKey: envelope.canonicalKey,
    finalUrl: envelope.finalUrl,
    httpStatus: envelope.httpStatus,
    redirectChain: envelope.redirectChain.map((hop) => hop.url),
    blocked: envelope.blocked,
    artifacts: envelope.artifacts.map((artifact) => ({
      kind: artifact.kind,
      relativePath: artifact.relativePath,
      mediaType: artifact.mediaType,
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
    })),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
