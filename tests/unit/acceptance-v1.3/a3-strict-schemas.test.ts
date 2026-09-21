// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  FocusV1,
  GenerateBody,
  RetryBody,
  WorkspacePut,
  validateFocusSelection,
  type FocusV1 as FocusV1Type,
  type RecommendationV1,
} from "../../../src/domain/tailoringWorkspace";

/**
 * A3: strict schemas accept valid bounded inputs; extra
 * actor/now/path/score and >20 selections fail; semantic checks
 * reject duplicate IDs/mapping pairs, invalid parent/note
 * combinations, and mismatched profile pairs.
 */

const PROFILE_VERSION_ID = "00000000-0000-4000-8000-000000000003";
const PARENT_VERSION_ID = "00000000-0000-4000-8000-000000000005";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const FOCUS: FocusV1Type = {
  schemaVersion: "tailoring-focus/v1",
  selectedPhraseIds: [],
  themeId: null,
  summaryDirection: "",
  mappings: [],
  additionalGuidance: "",
};

const DRAFT = {
  schemaVersion: "tailoring-workspace/v1",
  extractionId: null,
  profileId: null,
  profileVersionId: null,
  requestKind: "INITIAL",
  parentVersionId: null,
  revisionNote: null,
  recommendationHash: null,
  focus: FOCUS,
};

describe("A3 strict bounds and extra-field rejection", () => {
  it("accepts the valid bounded empty draft", () => {
    expect(WorkspacePut.parse(DRAFT)).toEqual(DRAFT);
    expect(FocusV1.parse(FOCUS)).toEqual(FOCUS);
  });

  it("rejects extra actor/now/path/score fields on every v1.3 request body", () => {
    const generate = {
      schemaVersion: "tailoring-submit/v1",
      requestId: "00000000-0000-4000-8000-000000000004",
      workspaceRevision: 1,
      observedRowVersion: 1,
    };
    const retry = {
      schemaVersion: "tailoring-retry/v1",
      observedAttemptId: "00000000-0000-4000-8000-000000000006",
      observedRowVersion: 1,
    };
    for (const extra of [
      { actor: "human" },
      { now: "2026-09-16T12:00:00.000Z" },
      { outputPath: "/tmp/resume.pdf" },
      { score: 82 },
    ]) {
      expect(WorkspacePut.safeParse({ ...DRAFT, ...extra }).success).toBe(false);
      expect(FocusV1.safeParse({ ...FOCUS, ...extra }).success).toBe(false);
      expect(GenerateBody.safeParse({ ...generate, ...extra }).success).toBe(false);
      expect(RetryBody.safeParse({ ...retry, ...extra }).success).toBe(false);
    }
  });

  it("rejects more than 20 selected phrases", () => {
    const ids = Array.from({ length: 21 }, (_, index) => index.toString(16).padStart(64, "0"));
    expect(FocusV1.safeParse({ ...FOCUS, selectedPhraseIds: ids }).success).toBe(false);
    expect(FocusV1.safeParse({ ...FOCUS, selectedPhraseIds: ids.slice(0, 20) }).success).toBe(true);
  });
});

describe("A3 semantic checks", () => {
  it("rejects duplicate selected ids and duplicate mapping pairs", () => {
    expect(FocusV1.safeParse({ ...FOCUS, selectedPhraseIds: [HASH_A, HASH_A] }).success).toBe(
      false,
    );
    const mapping = { roleId: "role-1", phraseId: HASH_A, factIds: ["fact-1"] };
    expect(FocusV1.safeParse({ ...FOCUS, mappings: [mapping, mapping] }).success).toBe(false);
  });

  it("rejects invalid parent/note combinations for every request kind", () => {
    expect(
      WorkspacePut.safeParse({
        ...DRAFT,
        requestKind: "INITIAL",
        parentVersionId: PARENT_VERSION_ID,
      }).success,
    ).toBe(false);
    expect(
      WorkspacePut.safeParse({ ...DRAFT, requestKind: "NEW_VERSION", parentVersionId: null })
        .success,
    ).toBe(false);
    expect(
      WorkspacePut.safeParse({
        ...DRAFT,
        requestKind: "REVISION",
        parentVersionId: PARENT_VERSION_ID,
        revisionNote: null,
      }).success,
    ).toBe(false);
    expect(
      WorkspacePut.safeParse({
        ...DRAFT,
        requestKind: "REVISION",
        parentVersionId: PARENT_VERSION_ID,
        revisionNote: "Tighten the routing bullet.",
      }).success,
    ).toBe(true);
  });

  it("rejects mismatched profile pairs", () => {
    expect(
      WorkspacePut.safeParse({ ...DRAFT, profileId: "local", profileVersionId: null }).success,
    ).toBe(false);
    expect(
      WorkspacePut.safeParse({ ...DRAFT, profileId: null, profileVersionId: PROFILE_VERSION_ID })
        .success,
    ).toBe(false);
  });

  it("rejects unknown phrases and foreign role facts against the bound snapshot", () => {
    const recommendations: RecommendationV1 = {
      schemaVersion: "tailoring-recommendations/v1",
      policyVersion: "recommendations/1",
      extractionId: "00000000-0000-4000-8000-000000000002",
      jdHash: HASH_A,
      profileVersionId: PROFILE_VERSION_ID,
      profileHash: HASH_B,
      phrases: [
        {
          id: HASH_A,
          text: "supply chain roadmap",
          startByte: 0,
          endByte: 20,
          excerpt: "…",
          count: 1,
          category: "product",
          support: "supported",
          factIds: ["fact-1"],
        },
      ],
      roles: [{ id: "role-1", label: "Lead PM", factIds: ["fact-1"] }],
      themes: [],
      preset: FOCUS,
    };
    const unknown = FocusV1.parse({ ...FOCUS, selectedPhraseIds: [HASH_B] });
    expect(validateFocusSelection(unknown, recommendations).map((issue) => issue.code)).toEqual([
      "UNKNOWN_PHRASE",
    ]);
    const foreign = FocusV1.parse({
      ...FOCUS,
      mappings: [{ roleId: "role-1", phraseId: HASH_A, factIds: ["fact-9"] }],
    });
    expect(validateFocusSelection(foreign, recommendations).map((issue) => issue.code)).toEqual([
      "FOREIGN_FACT",
    ]);
  });
});
