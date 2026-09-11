// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  FETCH_ENVELOPE_VERSION,
  FetchEnvelopeV1,
  hashFetchEnvelope,
} from "../../../src/scraping/envelope";

const ENVELOPE = {
  schemaVersion: FETCH_ENVELOPE_VERSION,
  submittedUrl: "https://example.com/jobs/1?utm_source=x",
  canonicalUrl: "https://example.com/jobs/1",
  canonicalKey: "url:https://example.com/jobs/1",
  finalUrl: "https://example.com/jobs/1",
  httpStatus: 200,
  redirectChain: [],
  blocked: null,
  artifacts: [
    {
      kind: "HTML",
      relativePath: "ab/abc.html",
      mediaType: "text/html; charset=utf-8",
      byteSize: 12,
      sha256: "a".repeat(64),
    },
  ],
  fetchedAt: "2026-09-11T12:00:00.000Z",
} as const;

describe("fetch envelope", () => {
  it("parses a complete envelope", () => {
    const parsed = FetchEnvelopeV1.safeParse(ENVELOPE);
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown versions and malformed refs", () => {
    expect(
      FetchEnvelopeV1.safeParse({ ...ENVELOPE, schemaVersion: "fetch-v9" })
        .success,
    ).toBe(false);
    expect(
      FetchEnvelopeV1.safeParse({
        ...ENVELOPE,
        artifacts: [
          { ...ENVELOPE.artifacts[0], relativePath: "../escape.html" },
        ],
      }).success,
    ).toBe(false);
    expect(
      FetchEnvelopeV1.safeParse({
        ...ENVELOPE,
        artifacts: [{ ...ENVELOPE.artifacts[0], sha256: "nope" }],
      }).success,
    ).toBe(false);
  });

  it("hashes deterministically over fetch identity", () => {
    const left = FetchEnvelopeV1.parse(ENVELOPE);
    const right = FetchEnvelopeV1.parse({ ...ENVELOPE });
    expect(hashFetchEnvelope(left)).toBe(hashFetchEnvelope(right));
    expect(hashFetchEnvelope(left)).toMatch(/^[0-9a-f]{64}$/);
    const changed = FetchEnvelopeV1.parse({
      ...ENVELOPE,
      finalUrl: "https://example.com/jobs/2",
    });
    expect(hashFetchEnvelope(changed)).not.toBe(hashFetchEnvelope(left));
  });
});
