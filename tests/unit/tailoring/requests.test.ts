// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  SteeringSnapshotV1,
  TailorQueuePayloadV2,
  canonicalKeywordSet,
  generationRequestIdentity,
  hashGenerationRequest,
  type RequestHashInput,
} from "../../../src/tailoring/requests";

/**
 * Explicit generation request contracts (WO-1.2-D): canonical keyword
 * set, request identity, payload hash stability/sensitivity, and the
 * strict v2 queue payload. Pure — no database.
 */

const HASH_INPUT: RequestHashInput = {
  requestIdentity: "genreq:v1:req-1",
  jobId: "job-1",
  extractionId: "ext-1",
  profileId: "local",
  profileVersionId: "ver-1",
  jdSnapshotId: "jd-1",
  parentVersionId: null,
  requestKind: "INITIAL",
  steeringSnapshot: {
    schemaVersion: "generation-steering/v1",
    profileId: "local",
    profileVersionId: "ver-1",
    profileName: "default",
    profileDisplayName: "Primary Profile",
    executiveNarrative: null,
    targetTitles: ["Backend Engineer"],
    targetLocations: [],
    careerKeywords: [],
    workMode: [],
    workAuthorization: [],
    sponsorshipRequired: null,
    willingToRelocate: null,
    yearsOfExperience: null,
  },
  selectedKeywords: ["Go", "Kubernetes"],
  directivesText: null,
  revisionNote: null,
};

describe("canonicalKeywordSet", () => {
  it("trims, dedupes, drops empties, and sorts", () => {
    expect(canonicalKeywordSet([" Kubernetes ", "Kubernetes", "Go", "  "])).toEqual([
      "Go",
      "Kubernetes",
    ]);
    expect(canonicalKeywordSet(["b", "a"])).toEqual(["a", "b"]);
    expect(canonicalKeywordSet([])).toEqual([]);
    expect(canonicalKeywordSet(undefined)).toEqual([]);
  });
});

describe("generationRequestIdentity", () => {
  it("namespaces the client operation id", () => {
    expect(generationRequestIdentity("req-1")).toBe("genreq:v1:req-1");
    expect(generationRequestIdentity("req-2")).not.toBe(generationRequestIdentity("req-1"));
  });
});

describe("hashGenerationRequest", () => {
  it("is stable for identical input and emits 64-hex", () => {
    const first = hashGenerationRequest(HASH_INPUT);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(hashGenerationRequest(structuredClone(HASH_INPUT))).toBe(first);
  });

  it("forks on any covered field change", () => {
    const base = hashGenerationRequest(HASH_INPUT);
    const variants: RequestHashInput[] = [
      { ...HASH_INPUT, requestIdentity: "genreq:v1:req-2" },
      { ...HASH_INPUT, jobId: "job-2" },
      { ...HASH_INPUT, extractionId: "ext-2" },
      { ...HASH_INPUT, profileVersionId: "ver-2" },
      { ...HASH_INPUT, jdSnapshotId: "jd-2" },
      { ...HASH_INPUT, parentVersionId: "v-9", requestKind: "REVISION" },
      { ...HASH_INPUT, selectedKeywords: ["Go"] },
      { ...HASH_INPUT, directivesText: "Emphasize scale." },
      { ...HASH_INPUT, revisionNote: "Fix the caching bullet." },
      {
        ...HASH_INPUT,
        steeringSnapshot: { ...HASH_INPUT.steeringSnapshot, yearsOfExperience: 9 },
      },
    ];
    const hashes = new Set(variants.map((input) => hashGenerationRequest(input)));
    expect(hashes.size).toBe(variants.length);
    expect(hashes.has(base)).toBe(false);
  });
});

describe("TailorQueuePayloadV2", () => {
  const valid = {
    schemaVersion: "tailor-queue/v2",
    generationRequestId: "00000000-0000-4000-8000-000000000001",
    jobId: "job-1",
    extractionId: "ext-1",
    profileId: "local",
    profileVersionId: "ver-1",
    jdSnapshotId: "jd-1",
    payloadHash: "a".repeat(64),
  };

  it("parses a full v2 payload with an optional parent", () => {
    expect(TailorQueuePayloadV2.parse(valid)).toEqual(valid);
    expect(
      TailorQueuePayloadV2.parse({ ...valid, parentVersionId: "v-1" }),
    ).toMatchObject({ parentVersionId: "v-1" });
  });

  it("rejects legacy, short-hash, and extra-key payloads", () => {
    expect(
      TailorQueuePayloadV2.safeParse({ ...valid, schemaVersion: "tailor-queue/v1" }).success,
    ).toBe(false);
    expect(
      TailorQueuePayloadV2.safeParse({ ...valid, payloadHash: "abc" }).success,
    ).toBe(false);
    expect(
      TailorQueuePayloadV2.safeParse({ ...valid, guidance: { note: "x" } }).success,
    ).toBe(false);
    const { payloadHash: _dropped, ...missing } = valid;
    expect(TailorQueuePayloadV2.safeParse(missing).success).toBe(false);
  });
});

describe("SteeringSnapshotV1", () => {
  it("parses the frozen steering the command records", () => {
    expect(SteeringSnapshotV1.parse(HASH_INPUT.steeringSnapshot)).toEqual(
      HASH_INPUT.steeringSnapshot,
    );
    expect(
      SteeringSnapshotV1.safeParse({ ...HASH_INPUT.steeringSnapshot, extra: true }).success,
    ).toBe(false);
  });
});
