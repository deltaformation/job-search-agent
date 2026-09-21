// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  AssessmentV1,
  DecideBody,
  DeclineBody,
  FocusV1,
  GenerateBody,
  GenerationReply,
  MeasureSide,
  ProgressReply,
  RecommendationV1,
  RecommendationsReply,
  RetryBody,
  TailoringErrorBody,
  TailoringFailure,
  TailoringStage,
  V13_TRANSACTION_BINDINGS,
  V13_TRANSACTION_KEYS,
  WorkspacePut,
  WorkspaceReply,
  WorkspaceView,
  buildWorkspaceETag,
  parseWorkspaceETag,
  validateFocusSelection,
  type AssessmentV1 as AssessmentV1Type,
  type FocusV1 as FocusV1Type,
  type RecommendationV1 as RecommendationV1Type,
} from "../../../src/domain/tailoringWorkspace";

/**
 * WO-1.3-A developer suite for the §3 domain/API schemas: strictness,
 * bounds, and every semantic refinement. The criterion-exact A3/A4
 * assertions live in `tests/unit/acceptance-v1.3/`; this file proves
 * the schemas themselves.
 */

const JOB_ID = "00000000-0000-4000-8000-000000000001";
const EXTRACTION_ID = "00000000-0000-4000-8000-000000000002";
const PROFILE_VERSION_ID = "00000000-0000-4000-8000-000000000003";
const REQUEST_ID = "00000000-0000-4000-8000-000000000004";
const PARENT_VERSION_ID = "00000000-0000-4000-8000-000000000005";
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000006";
const WORK_ITEM_ID = "00000000-0000-4000-8000-000000000007";
const VERSION_ID = "00000000-0000-4000-8000-000000000008";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const NOW = "2026-09-16T12:00:00.000Z";

const EMPTY_FOCUS: FocusV1Type = {
  schemaVersion: "tailoring-focus/v1",
  selectedPhraseIds: [],
  themeId: null,
  summaryDirection: "",
  mappings: [],
  additionalGuidance: "",
};

function validRecommendations(): RecommendationV1Type {
  return {
    schemaVersion: "tailoring-recommendations/v1",
    policyVersion: "recommendations/1",
    extractionId: EXTRACTION_ID,
    jdHash: HASH_A,
    profileVersionId: PROFILE_VERSION_ID,
    profileHash: HASH_B,
    phrases: [
      {
        id: HASH_C,
        text: "supply chain roadmap",
        startByte: 0,
        endByte: 20,
        excerpt: "…lead the supply chain roadmap…",
        count: 3,
        category: "product",
        support: "supported",
        factIds: ["fact-1"],
      },
      {
        id: HASH_D,
        text: "NetSuite ERP administration",
        startByte: 20,
        endByte: 47,
        excerpt: "…NetSuite ERP administration…",
        count: 1,
        category: "erp",
        support: "gap",
        factIds: [],
      },
    ],
    roles: [{ id: "role-1", label: "Lead PM", factIds: ["fact-1"] }],
    themes: [
      { id: "theme-1", title: "Logistics", factIds: ["fact-1"], summaryDirection: "Lead with ops." },
    ],
    preset: EMPTY_FOCUS,
  };
}

function validWorkspacePut(): Record<string, unknown> {
  return {
    schemaVersion: "tailoring-workspace/v1",
    extractionId: null,
    profileId: null,
    profileVersionId: null,
    requestKind: "INITIAL",
    parentVersionId: null,
    revisionNote: null,
    recommendationHash: null,
    focus: EMPTY_FOCUS,
  };
}

describe("FocusV1", () => {
  it("parses the empty saveable draft", () => {
    expect(FocusV1.parse(EMPTY_FOCUS)).toEqual(EMPTY_FOCUS);
  });

  it("rejects more than 20 selected phrases", () => {
    const selectedPhraseIds = Array.from({ length: 21 }, (_, index) =>
      index.toString(16).padStart(64, "0"),
    );
    expect(FocusV1.safeParse({ ...EMPTY_FOCUS, selectedPhraseIds }).success).toBe(false);
    expect(
      FocusV1.safeParse({ ...EMPTY_FOCUS, selectedPhraseIds: selectedPhraseIds.slice(0, 20) })
        .success,
    ).toBe(true);
  });

  it("rejects duplicate selected phrase ids", () => {
    const parsed = FocusV1.safeParse({ ...EMPTY_FOCUS, selectedPhraseIds: [HASH_A, HASH_A] });
    expect(parsed.success).toBe(false);
  });

  it("rejects duplicate (roleId, phraseId) mapping pairs but allows same phrase on two roles", () => {
    const mapping = { roleId: "role-1", phraseId: HASH_A, factIds: ["fact-1"] };
    expect(FocusV1.safeParse({ ...EMPTY_FOCUS, mappings: [mapping, mapping] }).success).toBe(false);
    expect(
      FocusV1.safeParse({
        ...EMPTY_FOCUS,
        mappings: [mapping, { ...mapping, roleId: "role-2" }],
      }).success,
    ).toBe(true);
  });

  it("rejects extra keys and over-long free text", () => {
    expect(FocusV1.safeParse({ ...EMPTY_FOCUS, actor: "human" }).success).toBe(false);
    expect(FocusV1.safeParse({ ...EMPTY_FOCUS, summaryDirection: "x".repeat(4001) }).success).toBe(
      false,
    );
    expect(
      FocusV1.safeParse({ ...EMPTY_FOCUS, additionalGuidance: "x".repeat(1001) }).success,
    ).toBe(false);
    expect(
      FocusV1.safeParse({
        ...EMPTY_FOCUS,
        mappings: Array.from({ length: 101 }, (_, index) => ({
          roleId: `role-${index}`,
          phraseId: HASH_A,
          factIds: ["fact-1"],
        })),
      }).success,
    ).toBe(false);
  });
});

describe("RecommendationV1", () => {
  it("parses a sparse recommendation with empty collections", () => {
    const sparse = { ...validRecommendations(), phrases: [], roles: [], themes: [] };
    expect(RecommendationV1.parse(sparse)).toEqual(sparse);
  });

  it("rejects endByte that does not exceed startByte", () => {
    const base = validRecommendations();
    const zeroWidth = {
      ...base.phrases[0],
      startByte: 5,
      endByte: 5,
    };
    expect(RecommendationV1.safeParse({ ...base, phrases: [zeroWidth] }).success).toBe(false);
    const inverted = { ...base.phrases[0], startByte: 9, endByte: 4 };
    expect(RecommendationV1.safeParse({ ...base, phrases: [inverted] }).success).toBe(false);
  });

  it("rejects duplicate phrase, role, and theme ids", () => {
    const base = validRecommendations();
    expect(
      RecommendationV1.safeParse({ ...base, phrases: [base.phrases[0], base.phrases[0]] }).success,
    ).toBe(false);
    expect(
      RecommendationV1.safeParse({ ...base, roles: [base.roles[0], base.roles[0]] }).success,
    ).toBe(false);
    expect(
      RecommendationV1.safeParse({ ...base, themes: [base.themes[0], base.themes[0]] }).success,
    ).toBe(false);
  });

  it("rejects extra keys and oversized collections", () => {
    const base = validRecommendations();
    expect(RecommendationV1.safeParse({ ...base, score: 82 }).success).toBe(false);
    const many = Array.from({ length: 101 }, (_, index) => ({
      ...base.phrases[0],
      id: index.toString(16).padStart(64, "0"),
      startByte: index,
      endByte: index + 1,
    }));
    expect(RecommendationV1.safeParse({ ...base, phrases: many }).success).toBe(false);
  });
});

describe("WorkspacePut", () => {
  it("parses the empty INITIAL draft", () => {
    expect(WorkspacePut.parse(validWorkspacePut())).toEqual(validWorkspacePut());
  });

  it("requires profileId and profileVersionId as a pair", () => {
    const base = validWorkspacePut();
    expect(
      WorkspacePut.safeParse({ ...base, profileId: "local", profileVersionId: null }).success,
    ).toBe(false);
    expect(
      WorkspacePut.safeParse({ ...base, profileId: null, profileVersionId: PROFILE_VERSION_ID })
        .success,
    ).toBe(false);
    expect(
      WorkspacePut.safeParse({
        ...base,
        profileId: "local",
        profileVersionId: PROFILE_VERSION_ID,
      }).success,
    ).toBe(true);
  });

  it("enforces the INITIAL/NEW_VERSION/REVISION parent/note matrix", () => {
    const base = validWorkspacePut();
    expect(
      WorkspacePut.safeParse({ ...base, requestKind: "INITIAL", parentVersionId: PARENT_VERSION_ID })
        .success,
    ).toBe(false);
    expect(
      WorkspacePut.safeParse({ ...base, requestKind: "INITIAL", revisionNote: "note" }).success,
    ).toBe(false);
    expect(
      WorkspacePut.safeParse({ ...base, requestKind: "NEW_VERSION", parentVersionId: null }).success,
    ).toBe(false);
    expect(
      WorkspacePut.safeParse({
        ...base,
        requestKind: "NEW_VERSION",
        parentVersionId: PARENT_VERSION_ID,
        revisionNote: "note",
      }).success,
    ).toBe(false);
    expect(
      WorkspacePut.safeParse({
        ...base,
        requestKind: "NEW_VERSION",
        parentVersionId: PARENT_VERSION_ID,
      }).success,
    ).toBe(true);
    expect(
      WorkspacePut.safeParse({
        ...base,
        requestKind: "REVISION",
        parentVersionId: PARENT_VERSION_ID,
        revisionNote: null,
      }).success,
    ).toBe(false);
    expect(
      WorkspacePut.safeParse({
        ...base,
        requestKind: "REVISION",
        parentVersionId: PARENT_VERSION_ID,
        revisionNote: "   ",
      }).success,
    ).toBe(false);
    expect(
      WorkspacePut.safeParse({
        ...base,
        requestKind: "REVISION",
        parentVersionId: PARENT_VERSION_ID,
        revisionNote: "Sharpen the routing bullet.",
      }).success,
    ).toBe(true);
  });

  it("rejects injected actor/now/path fields", () => {
    const base = validWorkspacePut();
    expect(WorkspacePut.safeParse({ ...base, actor: "human" }).success).toBe(false);
    expect(WorkspacePut.safeParse({ ...base, now: NOW }).success).toBe(false);
    expect(WorkspacePut.safeParse({ ...base, templatePath: "/tmp/x" }).success).toBe(false);
  });
});

describe("GenerateBody and RetryBody", () => {
  it("parses valid submission and retry bodies", () => {
    expect(
      GenerateBody.parse({
        schemaVersion: "tailoring-submit/v1",
        requestId: REQUEST_ID,
        workspaceRevision: 3,
        observedRowVersion: 7,
      }),
    ).toMatchObject({ requestId: REQUEST_ID });
    expect(
      RetryBody.parse({
        schemaVersion: "tailoring-retry/v1",
        observedAttemptId: ATTEMPT_ID,
        observedRowVersion: 7,
      }),
    ).toMatchObject({ observedAttemptId: ATTEMPT_ID });
  });

  it("rejects extra actor/now/path/score fields and non-positive counters", () => {
    const generate = {
      schemaVersion: "tailoring-submit/v1",
      requestId: REQUEST_ID,
      workspaceRevision: 3,
      observedRowVersion: 7,
    };
    for (const extra of [{ actor: "human" }, { now: NOW }, { outputPath: "/tmp/x" }, { score: 9 }]) {
      expect(GenerateBody.safeParse({ ...generate, ...extra }).success).toBe(false);
    }
    expect(GenerateBody.safeParse({ ...generate, workspaceRevision: 0 }).success).toBe(false);
    expect(GenerateBody.safeParse({ ...generate, observedRowVersion: 0 }).success).toBe(false);
    const retry = {
      schemaVersion: "tailoring-retry/v1",
      observedAttemptId: ATTEMPT_ID,
      observedRowVersion: 7,
    };
    expect(RetryBody.safeParse({ ...retry, actor: "human" }).success).toBe(false);
    expect(RetryBody.safeParse({ ...retry, leaseToken: "tok" }).success).toBe(false);
  });
});

describe("DecideBody and DeclineBody", () => {
  it("keeps the approval note optional but requires a decline reason", () => {
    expect(
      DecideBody.parse({ resumeVersionId: VERSION_ID, observedRowVersion: 2 }),
    ).toMatchObject({ resumeVersionId: VERSION_ID });
    expect(
      DecideBody.safeParse({ resumeVersionId: VERSION_ID, observedRowVersion: 2, actor: "human" })
        .success,
    ).toBe(false);
    expect(
      DeclineBody.safeParse({ resumeVersionId: VERSION_ID, observedRowVersion: 2 }).success,
    ).toBe(false);
    expect(
      DeclineBody.safeParse({ resumeVersionId: VERSION_ID, observedRowVersion: 2, note: "  " })
        .success,
    ).toBe(false);
    expect(
      DeclineBody.parse({ resumeVersionId: VERSION_ID, observedRowVersion: 2, note: "Stale JD." }),
    ).toMatchObject({ note: "Stale JD." });
  });
});

describe("Workspace and recommendation replies", () => {
  it("accepts a null workspace for the absent-workspace read", () => {
    expect(WorkspaceReply.parse({ ok: true, workspace: null })).toEqual({
      ok: true,
      workspace: null,
    });
  });

  it("parses a full workspace view", () => {
    const view = {
      jobId: JOB_ID,
      revision: 2,
      draft: validWorkspacePut(),
      recommendations: null,
      lastRequestId: null,
      lastSubmittedRevision: null,
      updatedAt: NOW,
    };
    expect(WorkspaceView.parse(view)).toEqual(view);
    expect(WorkspaceReply.parse({ ok: true, workspace: view })).toMatchObject({ ok: true });
  });

  it("parses the recommendations reply with its hash", () => {
    const recommendations = validRecommendations();
    expect(
      RecommendationsReply.parse({ ok: true, recommendations, recommendationHash: HASH_A }),
    ).toMatchObject({ recommendationHash: HASH_A });
  });

  it("parses generation replies including replays", () => {
    expect(
      GenerationReply.parse({
        ok: true,
        requestId: REQUEST_ID,
        workItemId: WORK_ITEM_ID,
        status: "QUEUED",
        replayed: false,
        jobRowVersion: 4,
        workspaceRevision: 5,
      }),
    ).toMatchObject({ replayed: false });
  });
});

describe("ProgressReply", () => {
  function validProgress(): Record<string, unknown> {
    return {
      ok: true,
      requestId: REQUEST_ID,
      state: "RUNNING",
      serverNow: NOW,
      attemptId: ATTEMPT_ID,
      startedAt: NOW,
      finishedAt: null,
      leaseExpiresAt: "2026-09-16T12:05:00.000Z",
      lastHeartbeatAt: NOW,
      events: [
        { seq: 1, stage: "PREPARING_INPUTS", source: "provider", recordedAt: NOW },
        { seq: 2, stage: "WAITING_FOR_PROVIDER", source: "provider", recordedAt: NOW },
      ],
      failure: null,
      resumeVersionId: null,
      retryAllowed: false,
    };
  }

  it("parses queued progress with no attempt or timer", () => {
    const queued = {
      ...validProgress(),
      state: "QUEUED",
      attemptId: null,
      startedAt: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      events: [],
    };
    expect(ProgressReply.parse(queued)).toMatchObject({ state: "QUEUED", events: [] });
  });

  it("rejects more than five events and unknown stages", () => {
    const base = validProgress();
    const stages = TailoringStage.options;
    const six = Array.from({ length: 6 }, (_, index) => ({
      seq: index + 1,
      stage: stages[index % stages.length],
      source: "provider",
      recordedAt: NOW,
    }));
    expect(ProgressReply.safeParse({ ...base, events: six }).success).toBe(false);
    expect(
      ProgressReply.safeParse({
        ...base,
        events: [{ seq: 1, stage: "ASKING_CANDIDATE", source: "provider", recordedAt: NOW }],
      }).success,
    ).toBe(false);
  });

  it("covers every failure code with its recovery action", () => {
    for (const code of TailoringFailure.shape.code.options) {
      const parsed = TailoringFailure.safeParse({
        code,
        stage: null,
        occurredAt: NOW,
        action: "retry",
        retryAfterSeconds: null,
        launchSubcode: code === "LOCAL_LAUNCH" ? "ENOENT" : null,
      });
      expect(parsed.success, code).toBe(true);
    }
    expect(
      TailoringFailure.safeParse({
        code: "LOCAL_LAUNCH",
        stage: "WAITING_FOR_PROVIDER",
        occurredAt: NOW,
        action: "open_settings",
        retryAfterSeconds: null,
        launchSubcode: "EACCES",
      }).success,
    ).toBe(true);
  });
});

describe("AssessmentV1", () => {
  function validAssessment(): AssessmentV1Type {
    return {
      schemaVersion: "resume-assessment/v1",
      policyVersion: "assessment/1",
      measures: [
        {
          key: "selected_keywords",
          original: { status: "assessed", numerator: 2, denominator: 4 },
          tailored: { status: "assessed", numerator: 3, denominator: 4 },
          itemIds: ["a", "b", "c", "d"],
        },
        {
          key: "supported_requirements",
          original: { status: "not_assessed", reason: "BASELINE_UNAVAILABLE" },
          tailored: { status: "assessed", numerator: 3, denominator: 5 },
          itemIds: ["r1", "r2", "r3", "r4", "r5"],
        },
        {
          key: "document_checks",
          original: { status: "not_assessed", reason: "BASELINE_UNAVAILABLE" },
          tailored: { status: "assessed", numerator: 4, denominator: 4 },
          itemIds: ["c1", "c2", "c3", "c4"],
        },
        {
          key: "evidence_integrity",
          original: { status: "not_assessed", reason: "CHECK_NOT_APPLICABLE" },
          tailored: { status: "assessed", numerator: 9, denominator: 9 },
          itemIds: ["k1"],
        },
      ],
    };
  }

  it("parses the four-measure policy with mixed sides", () => {
    expect(AssessmentV1.parse(validAssessment())).toEqual(validAssessment());
  });

  it("rejects numerator above denominator on either side", () => {
    const base = validAssessment();
    const over = structuredClone(base);
    over.measures[0] = {
      ...over.measures[0],
      tailored: { status: "assessed", numerator: 5, denominator: 4 },
    };
    expect(AssessmentV1.safeParse(over).success).toBe(false);
  });

  it("rejects duplicate measure keys and wrong measure counts", () => {
    const base = validAssessment();
    const duped = structuredClone(base);
    duped.measures[1] = { ...duped.measures[1], key: "selected_keywords" };
    expect(AssessmentV1.safeParse(duped).success).toBe(false);
    expect(AssessmentV1.safeParse({ ...base, measures: base.measures.slice(0, 3) }).success).toBe(
      false,
    );
  });

  it("rejects zero denominators and composite score fields", () => {
    expect(
      MeasureSide.safeParse({ status: "assessed", numerator: 0, denominator: 0 }).success,
    ).toBe(false);
    expect(
      AssessmentV1.safeParse({ ...validAssessment(), overallScore: 82 }).success,
    ).toBe(false);
    expect(AssessmentV1.safeParse({ ...validAssessment(), atsScore: 90 }).success).toBe(false);
  });
});

describe("TailoringErrorBody", () => {
  it("parses every named error code with a nullable recovery action", () => {
    for (const code of TailoringErrorBody.shape.error.shape.code.options) {
      const parsed = TailoringErrorBody.safeParse({
        ok: false,
        error: { code, message: "explain", action: null },
      });
      expect(parsed.success, code).toBe(true);
    }
    expect(
      TailoringErrorBody.parse({
        ok: false,
        error: {
          code: "WORKSPACE_CONFLICT",
          message: "stale",
          currentWorkspaceRevision: 4,
          action: "reload",
        },
      }).error.code,
    ).toBe("WORKSPACE_CONFLICT");
  });

  it("rejects long messages and unknown codes", () => {
    expect(
      TailoringErrorBody.safeParse({
        ok: false,
        error: { code: "WORKSPACE_CONFLICT", message: "x".repeat(281), action: null },
      }).success,
    ).toBe(false);
    expect(
      TailoringErrorBody.safeParse({
        ok: false,
        error: { code: "TIMEOUT", message: "x", action: null },
      }).success,
    ).toBe(false);
  });
});

describe("validateFocusSelection", () => {
  it("accepts the empty draft with or without a binding", () => {
    expect(validateFocusSelection(EMPTY_FOCUS, null)).toEqual([]);
    expect(validateFocusSelection(EMPTY_FOCUS, validRecommendations())).toEqual([]);
  });

  it("rejects selections, mappings, and themes without a binding", () => {
    const focus: FocusV1Type = {
      ...EMPTY_FOCUS,
      selectedPhraseIds: [HASH_C],
      themeId: "theme-1",
      mappings: [{ roleId: "role-1", phraseId: HASH_C, factIds: ["fact-1"] }],
    };
    expect(validateFocusSelection(focus, null).map((issue) => issue.code).sort()).toEqual([
      "MAPPINGS_WITHOUT_BINDING",
      "SELECTION_WITHOUT_BINDING",
      "THEME_WITHOUT_BINDING",
    ]);
  });

  it("accepts a fully bound focus", () => {
    const focus: FocusV1Type = {
      ...EMPTY_FOCUS,
      selectedPhraseIds: [HASH_C],
      themeId: "theme-1",
      summaryDirection: "Lead with ops.",
      mappings: [{ roleId: "role-1", phraseId: HASH_C, factIds: ["fact-1"] }],
      additionalGuidance: "Keep it tight.",
    };
    expect(validateFocusSelection(focus, validRecommendations())).toEqual([]);
  });

  it("rejects gap selections, unknown ids, and foreign facts", () => {
    const recommendations = validRecommendations();
    expect(
      validateFocusSelection({ ...EMPTY_FOCUS, selectedPhraseIds: [HASH_D] }, recommendations).map(
        (issue) => issue.code,
      ),
    ).toEqual(["INELIGIBLE_PHRASE"]);
    expect(
      validateFocusSelection({ ...EMPTY_FOCUS, selectedPhraseIds: [HASH_A] }, recommendations).map(
        (issue) => issue.code,
      ),
    ).toEqual(["UNKNOWN_PHRASE"]);
    expect(
      validateFocusSelection({ ...EMPTY_FOCUS, themeId: "theme-9" }, recommendations).map(
        (issue) => issue.code,
      ),
    ).toEqual(["UNKNOWN_THEME"]);
    const focus: FocusV1Type = {
      ...EMPTY_FOCUS,
      mappings: [{ roleId: "role-9", phraseId: HASH_A, factIds: ["fact-1"] }],
    };
    expect(validateFocusSelection(focus, recommendations).map((issue) => issue.code).sort()).toEqual(
      ["UNKNOWN_MAPPING_PHRASE", "UNKNOWN_ROLE"],
    );
    const foreign: FocusV1Type = {
      ...EMPTY_FOCUS,
      mappings: [{ roleId: "role-1", phraseId: HASH_C, factIds: ["fact-9"] }],
    };
    const issues = validateFocusSelection(foreign, recommendations);
    expect(issues.map((issue) => issue.code)).toEqual(["FOREIGN_FACT"]);
    expect(issues[0]?.field).toBe("mappings.0.factIds.0");
  });

  it("rejects selected terms above the provider length cap", () => {
    const recommendations = validRecommendations();
    recommendations.phrases[0] = {
      ...recommendations.phrases[0],
      text: "x".repeat(129),
    };
    expect(
      validateFocusSelection({ ...EMPTY_FOCUS, selectedPhraseIds: [HASH_C] }, recommendations).map(
        (issue) => issue.code,
      ),
    ).toEqual(["PHRASE_TOO_LONG"]);
  });
});

describe("workspace ETags", () => {
  it("round-trips job and revision, including revision 0", () => {
    expect(parseWorkspaceETag(buildWorkspaceETag(JOB_ID, 3))).toEqual({ jobId: JOB_ID, revision: 3 });
    expect(parseWorkspaceETag(buildWorkspaceETag(JOB_ID, 0))).toEqual({ jobId: JOB_ID, revision: 0 });
  });

  it("rejects wildcards, lists, and malformed tokens", () => {
    expect(parseWorkspaceETag("*")).toBeNull();
    expect(parseWorkspaceETag(`"tw:${JOB_ID}:1", "tw:${JOB_ID}:2"`)).toBeNull();
    expect(parseWorkspaceETag(`"tw:not-a-uuid:1"`)).toBeNull();
    expect(parseWorkspaceETag(`"tw:${JOB_ID}"`)).toBeNull();
    expect(parseWorkspaceETag("")).toBeNull();
  });
});

describe("V13 transaction bindings", () => {
  it("binds every transaction to exactly one owning order", () => {
    expect(V13_TRANSACTION_KEYS).toEqual(["W", "G", "R", "A", "D"]);
    expect(Object.keys(V13_TRANSACTION_BINDINGS).sort()).toEqual(["A", "D", "G", "R", "W"]);
    expect(V13_TRANSACTION_BINDINGS.W.owner).toBe("WO-1.3-B");
    expect(V13_TRANSACTION_BINDINGS.G.owner).toBe("WO-1.3-E");
    expect(V13_TRANSACTION_BINDINGS.R.owner).toBe("WO-1.3-F");
    expect(V13_TRANSACTION_BINDINGS.A.owner).toBe("WO-1.3-G");
    expect(V13_TRANSACTION_BINDINGS.D.owner).toBe("WO-1.3-G");
    for (const binding of Object.values(V13_TRANSACTION_BINDINGS)) {
      expect(binding.adrs.length).toBeGreaterThanOrEqual(1);
      expect(binding.service.length).toBeGreaterThan(0);
    }
  });

  it("keeps versioned request schemas disjoint across transactions", () => {
    const versioned = Object.values(V13_TRANSACTION_BINDINGS)
      .map((binding) => binding.requestSchema)
      .filter((schema) => schema.includes("/v"));
    expect(new Set(versioned).size).toBe(versioned.length);
    expect(versioned.sort()).toEqual([
      "tailoring-retry/v1",
      "tailoring-submit/v1",
      "tailoring-workspace/v1",
    ]);
  });
});
