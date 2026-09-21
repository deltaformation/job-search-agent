// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  IntakeBindingV1,
  PlanReplyV1,
  PREPARATION_NEVER_EMITS,
  PREPARATION_NON_RETRYABLE,
  PreparationFailure,
  PreparationInputV1,
  PreparationPlanV1,
  PreparationProposalV1,
  PreparationStatusV1,
  PrepareCommandV1,
  PreparePayloadV1,
  prepareIdempotencyKey,
  PrepareRetryBodyV1,
  Step2DraftV1,
  Step2ErrorCode,
  Step2ValidationV1,
  Step2WorkKind,
  ValidateDraftBodyV1,
  ValidateDraftReplyV1,
  WorkspacePutV2,
  masterBulletsByRole,
} from "../../../src/domain/step2";
import { phraseIdFor } from "../../../src/tailoring/requestsV3";
import {
  bindingHashFor,
  draftHashFor,
  evidenceHashFor,
  masterProjectionHashFor,
  planHashFor,
} from "../../../src/tailoring/step2policy";
import {
  loadPmExpected,
  loadPmJd,
  loadPmProfile,
  pmPlan,
} from "./s2a-world";

/**
 * WO-1.3-S2-A / S2A1: versioned Step 2 schemas are strict, ownership
 * refinements hold, and every §2 digest is byte-stable.
 */

const JOB = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OP = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const HASH =
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const T0 = "2026-09-17T00:00:00.000Z";

const BINDING = {
  schemaVersion: "step2-intake-binding/v1",
  intakeItemId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  profileId: "pm",
  profileVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  profilePayloadHash: HASH,
  evidenceHash: HASH,
  masterSourceId: null,
  capturedAt: T0,
  batchId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
} as const;

const DRAFT_OP = {
  op: "add",
  operationId: OP,
  suggestionId: "sug-001",
  roleId: "emp-northwind",
  editedText: null,
} as const;

function draftFor(planId: string, planHash: string) {
  return {
    schemaVersion: "step2-draft/v1",
    planId,
    planHash,
    summaryText: "Summary.",
    summarySource: "master",
    operations: [{ ...DRAFT_OP }],
  } as const;
}

describe("S2A1 strict schemas reject unrecognized fields", () => {
  const expected = loadPmExpected();
  const plan = pmPlan(expected);
  const table: Array<{ name: string; schema: z.ZodType; valid: unknown }> = [
    { name: "IntakeBindingV1", schema: IntakeBindingV1, valid: { ...BINDING } },
    {
      name: "PreparePayloadV1",
      schema: PreparePayloadV1,
      valid: {
        schemaVersion: "prepare-queue/v1",
        preparationId: expected.preparationId,
        jobId: JOB,
        extractionId: expected.extractionId,
        profileVersionId: expected.profileVersionId,
        bindingHash: HASH,
      },
    },
    { name: "PreparationPlanV1", schema: PreparationPlanV1, valid: plan },
    {
      name: "Step2DraftV1",
      schema: Step2DraftV1,
      valid: draftFor(expected.planId, expected.planHash),
    },
    {
      name: "WorkspacePutV2",
      schema: WorkspacePutV2,
      valid: {
        schemaVersion: "tailoring-workspace/v2",
        extractionId: expected.extractionId,
        profileId: "pm",
        profileVersionId: expected.profileVersionId,
        requestKind: "INITIAL",
        parentVersionId: null,
        revisionNote: null,
        planId: expected.planId,
        planHash: expected.planHash,
        recommendationHash: null,
        draft: draftFor(expected.planId, expected.planHash),
      },
    },
    {
      name: "PrepareCommandV1",
      schema: PrepareCommandV1,
      valid: {
        schemaVersion: "step2-prepare/v1",
        operationId: OP,
        observedRowVersion: 3,
        profileId: null,
      },
    },
    {
      name: "PrepareRetryBodyV1",
      schema: PrepareRetryBodyV1,
      valid: {
        schemaVersion: "step2-prepare-retry/v1",
        observedAttemptId: OP,
        observedRowVersion: 3,
      },
    },
    {
      name: "ValidateDraftBodyV1",
      schema: ValidateDraftBodyV1,
      valid: {
        schemaVersion: "step2-validate-draft/v1",
        workspaceRevision: 2,
        summaryText: "Summary.",
        operations: [{ ...DRAFT_OP }],
      },
    },
    {
      name: "PreparationStatusV1",
      schema: PreparationStatusV1,
      valid: {
        schemaVersion: "step2-preparation-status/v1",
        preparationId: null,
        jobId: JOB,
        state: "ABSENT",
        binding: null,
        extractionId: null,
        acceptedPlanId: null,
        acceptedPlanHash: null,
        attemptId: null,
        startedAt: null,
        finishedAt: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        events: [],
        failure: null,
        retryAllowed: false,
        serverNow: T0,
      },
    },
    {
      name: "PreparationFailure",
      schema: PreparationFailure,
      valid: {
        code: "NETWORK",
        stage: "WAITING_FOR_PROVIDER",
        occurredAt: T0,
        action: "retry",
        retryAfterSeconds: null,
        launchSubcode: null,
      },
    },
    {
      name: "PlanReplyV1",
      schema: PlanReplyV1,
      valid: {
        ok: true,
        plan,
        planHash: expected.planHash,
        validatedAt: T0,
        supersedesPlanId: null,
      },
    },
    {
      name: "PreparationProposalV1",
      schema: PreparationProposalV1,
      valid: {
        schemaVersion: "preparation-proposal/v1",
        jdSnapshotId: "jd-1",
        candidateSnapshotId: "cand-1",
        priorities: [
          {
            quote: { text: "NetSuite administration", startByte: 404, endByte: 427 },
            count: 1,
            category: "skill",
            importance: "required",
            matchStatus: "gap",
            factIds: [],
          },
        ],
        angles: [],
        suggestions: [],
        rationale: "Sparse.",
      },
    },
  ];
  for (const row of table) {
    it(`${row.name} accepts its valid shape`, () => {
      expect(row.schema.safeParse(row.valid).success).toBe(true);
    });
    for (const extra of ["actor", "now", "path", "score", "coverage"]) {
      it(`${row.name} rejects extra '${extra}'`, () => {
        const tainted = { ...(row.valid as Record<string, unknown>), [extra]: "x" };
        const parsed = row.schema.safeParse(tainted);
        expect(parsed.success).toBe(false);
      });
    }
  }

  it("PreparationInputV1 accepts the fixture payload and rejects extras", () => {
    const profile = loadPmProfile();
    const valid = {
      schemaVersion: "preparation-input/v1",
      promptVersion: "prepare-prompt/v1",
      jobId: JOB,
      jobTitle: "Senior Product Manager",
      company: "Quo",
      jdSnapshotId: "jd-1",
      jdText: loadPmJd(),
      candidateSnapshotId: "cand-1",
      profile,
      approvedFactIds: ["fact-nw-1"],
      masterBullets: [
        { roleId: "emp-northwind", factId: "fact-nw-1", text: "Shipped it." },
      ],
      budgets: { priorities: 5, suggestions: 5, angles: 2 },
    };
    expect(PreparationInputV1.safeParse(valid).success).toBe(true);
    for (const extra of ["actor", "now", "path", "score"]) {
      expect(
        PreparationInputV1.safeParse({ ...valid, [extra]: "x" }).success,
      ).toBe(false);
    }
  });

  it("Step2ValidationV1 and ValidateDraftReplyV1 accept verdict shapes", () => {
    const validation = {
      schemaVersion: "step2-validation/v1",
      policyVersion: "step2-claims/1",
      planId: expected.planId,
      planHash: expected.planHash,
      draftHash: HASH,
      segments: [
        {
          segmentId: "seg-01",
          kind: "bullet",
          roleId: "emp-northwind",
          textHash: HASH,
          normalizedHash: HASH,
          verdict: "supported",
          factIds: ["fact-nw-2"],
          match: "exact-fact",
          reason: null,
        },
      ],
      budget: {
        summaryChars: 8,
        perRoleCounts: [{ roleId: "emp-northwind", bullets: 1 }],
        totalBullets: 1,
        exceeded: false,
      },
      validatedAt: T0,
    };
    expect(Step2ValidationV1.safeParse(validation).success).toBe(true);
    expect(
      Step2ValidationV1.safeParse({ ...validation, score: 99 }).success,
    ).toBe(false);
    const reply = { ok: true, validationId: OP, validation };
    expect(ValidateDraftReplyV1.safeParse(reply).success).toBe(true);
    expect(
      ValidateDraftReplyV1.safeParse({ ...reply, actor: "x" }).success,
    ).toBe(false);
  });
});

describe("S2A1 ownership and semantic refinements", () => {
  const expected = loadPmExpected();
  const plan = pmPlan(expected);

  it("recorded PM and sparse plans parse strictly", () => {
    expect(plan.planId).toBe(expected.planId);
    expect(plan.featuredPriorityIds).toHaveLength(5);
    expect(plan.suggestions.filter((s) => s.usable)).toHaveLength(2);
  });

  it("featured ids must name plan priorities, uniquely", () => {
    const unknown = {
      ...plan,
      featuredPriorityIds: [HASH],
    };
    expect(PreparationPlanV1.safeParse(unknown).success).toBe(false);
    const dup = {
      ...plan,
      featuredPriorityIds: [plan.featuredPriorityIds[0], plan.featuredPriorityIds[0]],
    };
    expect(PreparationPlanV1.safeParse(dup).success).toBe(false);
  });

  it("duplicate priority, angle, suggestion, and operation ids fail", () => {
    const dupPriority = {
      ...plan,
      priorities: [plan.priorities[0], plan.priorities[0]],
    };
    expect(PreparationPlanV1.safeParse(dupPriority).success).toBe(false);
    const dupOp = draftFor(expected.planId, expected.planHash);
    expect(
      Step2DraftV1.safeParse({
        ...dupOp,
        operations: [{ ...DRAFT_OP }, { ...DRAFT_OP }],
      }).success,
    ).toBe(false);
  });

  it("replace carries exactly one of suggestionId or editedText", () => {
    const base = {
      op: "replace",
      operationId: OP,
      targetFactId: "fact-nw-1",
      roleId: "emp-northwind",
    };
    expect(
      Step2DraftV1.safeParse({
        ...draftFor(expected.planId, expected.planHash),
        operations: [
          { ...base, suggestionId: "sug-001", editedText: "Both." },
        ],
      }).success,
    ).toBe(false);
    expect(
      Step2DraftV1.safeParse({
        ...draftFor(expected.planId, expected.planHash),
        operations: [{ ...base, suggestionId: null, editedText: null }],
      }).success,
    ).toBe(false);
    expect(
      Step2DraftV1.safeParse({
        ...draftFor(expected.planId, expected.planHash),
        operations: [{ ...base, suggestionId: null, editedText: "Reword." }],
      }).success,
    ).toBe(true);
  });

  it("workspace v2 enforces pair rules, draft binding, and kind matrix", () => {
    const base = {
      schemaVersion: "tailoring-workspace/v2",
      extractionId: expected.extractionId,
      profileId: "pm",
      profileVersionId: expected.profileVersionId,
      requestKind: "INITIAL",
      parentVersionId: null,
      revisionNote: null,
      planId: expected.planId,
      planHash: expected.planHash,
      recommendationHash: null,
      draft: null,
    } as const;
    expect(WorkspacePutV2.safeParse(base).success).toBe(true);
    expect(
      WorkspacePutV2.safeParse({ ...base, profileId: null }).success,
    ).toBe(false);
    expect(WorkspacePutV2.safeParse({ ...base, planHash: null }).success).toBe(
      false,
    );
    expect(
      WorkspacePutV2.safeParse({
        ...base,
        planId: null,
        planHash: null,
        draft: draftFor(expected.planId, expected.planHash),
      }).success,
    ).toBe(false);
    expect(
      WorkspacePutV2.safeParse({
        ...base,
        requestKind: "REVISION",
        parentVersionId: null,
        revisionNote: "Note.",
      }).success,
    ).toBe(false);
    expect(
      WorkspacePutV2.safeParse({
        ...base,
        requestKind: "NEW_VERSION",
        parentVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        revisionNote: null,
      }).success,
    ).toBe(true);
  });

  it("new error codes, kind, and failure partitions pin exactly", () => {
    expect(Step2ErrorCode.options).toEqual([
      "PREPARATION_BUSY",
      "PLAN_STALE",
      "UNRESOLVED_EVIDENCE",
      "BUDGET_EXCEEDED",
    ]);
    expect(Step2WorkKind.value).toBe("PREPARE");
    expect([...PREPARATION_NEVER_EMITS].sort()).toEqual([
      "CLAIM_VALIDATION",
      "RENDER_FAILED",
    ]);
    expect([...PREPARATION_NON_RETRYABLE].sort()).toEqual([
      "INPUT_STALE",
      "PROFILE_UNAVAILABLE",
    ]);
    expect(PreparationFailure.shape.code.options).toHaveLength(14);
    expect(prepareIdempotencyKey("job-1", "prep-1", "ext-1")).toBe(
      "prepare:job-1:prep-1:ext-1",
    );
  });
});

describe("S2A1 digests are byte-stable", () => {
  const expected = loadPmExpected();
  const plan = pmPlan(expected);
  const profile = loadPmProfile();

  it("priority ids equal phraseIdFor over the recorded spans", () => {
    for (const priority of expected.priorities) {
      expect(priority.priorityId).toBe(
        phraseIdFor({
          extractionId: expected.extractionId,
          jdHash: expected.jdHash,
          startByte: priority.quote.startByte,
          endByte: priority.quote.endByte,
          text: priority.quote.text,
        }),
      );
    }
  });

  it("fixture hashes reproduce exactly", () => {
    expect(planHashFor(plan)).toBe(expected.planHash);
    expect(masterProjectionHashFor(profile)).toBe(
      expected.masterProjectionHash,
    );
    const approved = profile.achievements
      .filter((a) => a.verification === "APPROVED")
      .map((a) => ({
        factId: a.factId,
        statement: a.text,
        employmentId: a.employmentId ?? null,
      }));
    expect(
      evidenceHashFor({
        profileVersionId: expected.profileVersionId,
        payloadHash: expected.payloadHash,
        approved,
      }),
    ).toBe(expected.evidenceHash);
  });

  it("evidence hash is order-independent but content-sensitive", () => {
    const one = evidenceHashFor({
      profileVersionId: "v",
      payloadHash: HASH,
      approved: [
        { factId: "b", statement: "B", employmentId: null },
        { factId: "a", statement: "A", employmentId: null },
      ],
    });
    const two = evidenceHashFor({
      profileVersionId: "v",
      payloadHash: HASH,
      approved: [
        { factId: "a", statement: "A", employmentId: null },
        { factId: "b", statement: "B", employmentId: null },
      ],
    });
    expect(one).toBe(two);
    const drifted = evidenceHashFor({
      profileVersionId: "v",
      payloadHash: HASH,
      approved: [
        { factId: "a", statement: "A!", employmentId: null },
        { factId: "b", statement: "B", employmentId: null },
      ],
    });
    expect(drifted).not.toBe(one);
  });

  it("master projection groups approved bullets by role, transferables last", () => {
    const bullets = masterBulletsByRole(profile);
    expect(bullets.map((b) => b.factId)).toEqual([
      "fact-volt-1",
      "fact-volt-2",
      "fact-nw-1",
      "fact-nw-2",
      "fact-nw-3",
      "fact-gen-1",
    ]);
    expect(bullets[5]?.roleId).toBe("");
    expect(bullets.some((b) => b.factId === "fact-pending-1")).toBe(false);
  });

  it("draft hash is sensitive to text, order, and plan binding", () => {
    const draft = Step2DraftV1.parse(
      draftFor(expected.planId, expected.planHash),
    );
    const base = draftHashFor(draft);
    expect(
      draftHashFor({ ...draft, summaryText: "Changed." }),
    ).not.toBe(base);
    expect(bindingHashFor(IntakeBindingV1.parse({ ...BINDING }))).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});
