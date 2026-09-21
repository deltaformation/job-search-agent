// @vitest-environment node
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/domain/canonical";
import type {
  FocusV1,
  RecommendationV1,
} from "../../../src/domain/tailoringWorkspace";
import {
  canonicalRequestBytes,
  generationRequestIdentity,
  hashGenerationRequest,
  TailorQueuePayloadV2,
  TAILOR_QUEUE_SCHEMA_VERSION_V2,
  type RequestHashInput,
} from "../../../src/tailoring/requests";
import {
  canonicalJsonByteLength,
  canonicalMasterText,
  canonicalV3PayloadBytes,
  extractUtf8ByteRange,
  hashGenerationRequestV3,
  hashMasterText,
  hashRecommendation,
  hashSubmission,
  hashWorkflowRequestInput,
  MASTER_TEXT_PROJECTION_VERSION,
  phraseIdFor,
  TailorQueuePayloadAnyVersion,
  TailorQueuePayloadV3,
  TAILOR_QUEUE_SCHEMA_VERSION_V3,
  type WorkflowRequestInput,
} from "../../../src/tailoring/requestsV3";

/**
 * WO-1.3-A v3 payload/hash suite (contracts §3.1). The v2 reader, v2
 * hash bytes, and the `genreq:v1:` identity are pinned here so any
 * accidental drift fails loudly; v3 only wraps them.
 */

const V2_INPUT: RequestHashInput = {
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

/** Golden v2 bytes observed from the current `canonicalRequestBytes` (2026-09-16). */
const GOLDEN_V2_BYTES =
  '{"directivesText":null,"extractionId":"ext-1","jdSnapshotId":"jd-1","jobId":"job-1","parentVersionId":null,"profileId":"local","profileVersionId":"ver-1","requestIdentity":"genreq:v1:req-1","requestKind":"INITIAL","revisionNote":null,"selectedKeywords":["Go","Kubernetes"],"steeringSnapshot":{"careerKeywords":[],"executiveNarrative":null,"profileDisplayName":"Primary Profile","profileId":"local","profileName":"default","profileVersionId":"ver-1","schemaVersion":"generation-steering/v1","sponsorshipRequired":null,"targetLocations":[],"targetTitles":["Backend Engineer"],"willingToRelocate":null,"workAuthorization":[],"workMode":[],"yearsOfExperience":null}}';
const GOLDEN_V2_HASH = "87641d262cd192af9f55a5d0b019ef679a0edc74f3f4033429d8d72109e85ad2";

const HASH_A = "a".repeat(64);
const INPUT_HASH = "1".repeat(64);

const FOCUS: FocusV1 = {
  schemaVersion: "tailoring-focus/v1",
  selectedPhraseIds: [HASH_A],
  themeId: "theme-1",
  summaryDirection: "Lead with ops.",
  mappings: [{ roleId: "role-1", phraseId: HASH_A, factIds: ["fact-1"] }],
  additionalGuidance: "Keep it tight.",
};

const RECOMMENDATIONS: RecommendationV1 = {
  schemaVersion: "tailoring-recommendations/v1",
  policyVersion: "recommendations/1",
  extractionId: "00000000-0000-4000-8000-000000000002",
  jdHash: HASH_A,
  profileVersionId: "00000000-0000-4000-8000-000000000003",
  profileHash: "b".repeat(64),
  phrases: [
    {
      id: HASH_A,
      text: "supply chain roadmap",
      startByte: 0,
      endByte: 20,
      excerpt: "…lead the supply chain roadmap…",
      count: 3,
      category: "product",
      support: "supported",
      factIds: ["fact-1"],
    },
  ],
  roles: [{ id: "role-1", label: "Lead PM", factIds: ["fact-1"] }],
  themes: [
    { id: "theme-1", title: "Logistics", factIds: ["fact-1"], summaryDirection: "Lead with ops." },
  ],
  preset: {
    schemaVersion: "tailoring-focus/v1",
    selectedPhraseIds: [HASH_A],
    themeId: "theme-1",
    summaryDirection: "Lead with ops.",
    mappings: [],
    additionalGuidance: "",
  },
};

function workflowInput(): WorkflowRequestInput {
  return {
    workspaceRevision: 4,
    focus: structuredClone(FOCUS),
    recommendations: structuredClone(RECOMMENDATIONS),
    candidateSnapshotId: "00000000-0000-4000-8000-000000000009",
    masterText: "Master resume text.",
    masterTextHash: hashMasterText(canonicalMasterText("Master resume text.")),
    projectionVersion: MASTER_TEXT_PROJECTION_VERSION,
  };
}

describe("v2 preservation", () => {
  it("keeps the v2 canonical bytes and hash byte-for-byte", () => {
    expect(canonicalRequestBytes(structuredClone(V2_INPUT))).toBe(GOLDEN_V2_BYTES);
    expect(hashGenerationRequest(structuredClone(V2_INPUT))).toBe(GOLDEN_V2_HASH);
  });

  it("keeps the v2 queue reader and genreq:v1 identity unchanged", () => {
    expect(generationRequestIdentity("req-1")).toBe("genreq:v1:req-1");
    expect(TAILOR_QUEUE_SCHEMA_VERSION_V2).toBe("tailor-queue/v2");
    const v2 = {
      schemaVersion: "tailor-queue/v2",
      generationRequestId: "00000000-0000-4000-8000-000000000004",
      jobId: "job-1",
      extractionId: "ext-1",
      profileId: "local",
      profileVersionId: "ver-1",
      jdSnapshotId: "jd-1",
      payloadHash: GOLDEN_V2_HASH,
    };
    expect(TailorQueuePayloadV2.parse(v2)).toEqual(v2);
    expect(TailorQueuePayloadV3.safeParse(v2).success).toBe(false);
  });
});

describe("TailorQueuePayloadV3", () => {
  const valid = {
    schemaVersion: TAILOR_QUEUE_SCHEMA_VERSION_V3,
    generationRequestId: "00000000-0000-4000-8000-000000000004",
    jobId: "job-1",
    extractionId: "ext-1",
    profileId: "local",
    profileVersionId: "ver-1",
    jdSnapshotId: "jd-1",
    payloadHash: GOLDEN_V2_HASH,
    inputHash: INPUT_HASH,
  };

  it("parses a v3 payload carrying the workflow input hash", () => {
    expect(TailorQueuePayloadV3.parse(valid)).toEqual(valid);
    expect(
      TailorQueuePayloadV3.parse({ ...valid, parentVersionId: "v-1" }),
    ).toMatchObject({ parentVersionId: "v-1" });
  });

  it("rejects v2 schema versions, missing inputHash, and extra keys", () => {
    expect(
      TailorQueuePayloadV3.safeParse({ ...valid, schemaVersion: "tailor-queue/v2" }).success,
    ).toBe(false);
    const { inputHash: _dropped, ...missing } = valid;
    expect(TailorQueuePayloadV3.safeParse(missing).success).toBe(false);
    expect(TailorQueuePayloadV3.safeParse({ ...valid, inputHash: "zz" }).success).toBe(false);
    expect(TailorQueuePayloadV3.safeParse({ ...valid, focus: {} }).success).toBe(false);
  });

  it("reads both versions through the migration-union reader and refuses v1", () => {
    expect(TailorQueuePayloadAnyVersion.parse(valid)).toEqual(valid);
    const v2 = { ...valid, schemaVersion: "tailor-queue/v2" } as Record<string, unknown>;
    delete v2["inputHash"];
    expect(TailorQueuePayloadAnyVersion.parse(v2)).toEqual(v2);
    expect(
      TailorQueuePayloadAnyVersion.safeParse({ ...valid, schemaVersion: "tailor-queue/v1" })
        .success,
    ).toBe(false);
  });
});

describe("hashRecommendation and phraseIdFor", () => {
  it("is stable and sensitive to recommendation content", () => {
    const base = hashRecommendation(RECOMMENDATIONS);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecommendation(structuredClone(RECOMMENDATIONS))).toBe(base);
    const changed = structuredClone(RECOMMENDATIONS);
    changed.phrases[0] = { ...changed.phrases[0], support: "gap", factIds: [] };
    expect(hashRecommendation(changed)).not.toBe(base);
  });

  it("names phrases by their canonical extraction/offset/text tuple", () => {
    const input = {
      extractionId: "ext-1",
      jdHash: HASH_A,
      startByte: 12,
      endByte: 32,
      text: "supply chain roadmap",
    };
    const base = phraseIdFor(input);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(phraseIdFor({ ...input })).toBe(base);
    expect(phraseIdFor({ ...input, startByte: 13 })).not.toBe(base);
    expect(phraseIdFor({ ...input, text: "supply chain roadmaps" })).not.toBe(base);
    expect(phraseIdFor({ ...input, extractionId: "ext-2" })).not.toBe(base);
  });

  it("hashes non-ASCII phrase text stably", () => {
    const input = {
      extractionId: "ext-1",
      jdHash: HASH_A,
      startByte: 0,
      endByte: 9,
      text: "cafés naïfs",
    };
    expect(phraseIdFor(input)).toBe(phraseIdFor({ ...input }));
    expect(phraseIdFor({ ...input, text: "cafes naifs" })).not.toBe(phraseIdFor(input));
  });
});

describe("hashWorkflowRequestInput", () => {
  it("is stable for identical frozen inputs", () => {
    const base = hashWorkflowRequestInput(workflowInput());
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(hashWorkflowRequestInput(workflowInput())).toBe(base);
  });

  it("forks on any frozen field change", () => {
    const base = hashWorkflowRequestInput(workflowInput());
    const variants: WorkflowRequestInput[] = [
      { ...workflowInput(), workspaceRevision: 5 },
      {
        ...workflowInput(),
        focus: { ...FOCUS, selectedPhraseIds: [] },
      },
      {
        ...workflowInput(),
        recommendations: { ...structuredClone(RECOMMENDATIONS), jdHash: "f".repeat(64) },
      },
      { ...workflowInput(), candidateSnapshotId: "00000000-0000-4000-8000-000000000010" },
      { ...workflowInput(), masterText: "Other master text." },
      { ...workflowInput(), masterTextHash: "e".repeat(64) },
    ];
    const hashes = new Set(variants.map((input) => hashWorkflowRequestInput(input)));
    expect(hashes.size).toBe(variants.length);
    expect(hashes.has(base)).toBe(false);
  });
});

describe("hashGenerationRequestV3", () => {
  it("wraps the golden v2 object with the input hash", () => {
    const bytes = canonicalV3PayloadBytes(structuredClone(V2_INPUT), INPUT_HASH);
    const parsed = JSON.parse(bytes) as { schemaVersion: string; base: unknown; inputHash: string };
    expect(parsed.schemaVersion).toBe("generation-hash/v3");
    expect(parsed.inputHash).toBe(INPUT_HASH);
    expect(canonicalJson(parsed.base)).toBe(GOLDEN_V2_BYTES);
    const hash = hashGenerationRequestV3(structuredClone(V2_INPUT), INPUT_HASH);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(GOLDEN_V2_HASH);
  });

  it("is stable and forks on v2 fields or the input hash", () => {
    const base = hashGenerationRequestV3(structuredClone(V2_INPUT), INPUT_HASH);
    expect(hashGenerationRequestV3(structuredClone(V2_INPUT), INPUT_HASH)).toBe(base);
    expect(hashGenerationRequestV3(structuredClone(V2_INPUT), "2".repeat(64))).not.toBe(base);
    expect(
      hashGenerationRequestV3({ ...structuredClone(V2_INPUT), jobId: "job-2" }, INPUT_HASH),
    ).not.toBe(base);
    expect(
      hashGenerationRequestV3(
        { ...structuredClone(V2_INPUT), selectedKeywords: ["Go"] },
        INPUT_HASH,
      ),
    ).not.toBe(base);
  });
});

describe("hashSubmission", () => {
  const input = {
    jobId: "job-1",
    requestId: "00000000-0000-4000-8000-000000000004",
    workspaceRevision: 4,
    observedRowVersion: 7,
  };

  it("is stable and forks on every submission field", () => {
    const base = hashSubmission(input);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSubmission({ ...input })).toBe(base);
    expect(hashSubmission({ ...input, jobId: "job-2" })).not.toBe(base);
    expect(
      hashSubmission({ ...input, requestId: "00000000-0000-4000-8000-000000000011" }),
    ).not.toBe(base);
    expect(hashSubmission({ ...input, workspaceRevision: 5 })).not.toBe(base);
    expect(hashSubmission({ ...input, observedRowVersion: 8 })).not.toBe(base);
  });
});

describe("canonicalMasterText", () => {
  it("normalizes CRLF/NUL/whitespace exactly like canonical JD text", () => {
    expect(canonicalMasterText("Summary line.\r\nSecond line.\rThird.\n")).toBe(
      "Summary line.\nSecond line.\nThird.",
    );
    expect(canonicalMasterText("  padded  ")).toBe("padded");
    expect(canonicalMasterText("a\0b")).toBe("ab");
    expect(hashMasterText(canonicalMasterText("Master"))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("extractUtf8ByteRange", () => {
  it("slices ASCII ranges exactly", () => {
    expect(extractUtf8ByteRange("supply chain roadmap", 0, 6)).toBe("supply");
    expect(extractUtf8ByteRange("supply chain roadmap", 7, 12)).toBe("chain");
  });

  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    // "é" is 2 UTF-8 bytes but 1 UTF-16 unit; "😀" is 4 bytes but 2 units.
    const text = "aé😀x";
    expect(extractUtf8ByteRange(text, 0, 1)).toBe("a");
    expect(extractUtf8ByteRange(text, 1, 3)).toBe("é");
    expect(extractUtf8ByteRange(text, 3, 7)).toBe("😀");
    expect(extractUtf8ByteRange(text, 7, 8)).toBe("x");
    // Splitting a multi-byte code point fails closed instead of citing �.
    expect(extractUtf8ByteRange(text, 2, 3)).toBeNull();
    expect(extractUtf8ByteRange(text, 3, 5)).toBeNull();
  });

  it("rejects inverted, empty, and out-of-bounds ranges", () => {
    expect(extractUtf8ByteRange("abc", 2, 2)).toBeNull();
    expect(extractUtf8ByteRange("abc", 2, 1)).toBeNull();
    expect(extractUtf8ByteRange("abc", -1, 2)).toBeNull();
    expect(extractUtf8ByteRange("abc", 0, 4)).toBeNull();
    expect(extractUtf8ByteRange("abc", 1.5, 3)).toBeNull();
  });
});

describe("canonicalJsonByteLength", () => {
  it("measures UTF-8 bytes rather than JS string length", () => {
    expect(canonicalJsonByteLength({ text: "😀" })).toBe(Buffer.byteLength('{"text":"😀"}', "utf8"));
    expect(canonicalJsonByteLength({ text: "😀" })).toBeGreaterThan('{"text":"😀"}'.length);
  });
});
