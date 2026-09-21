// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJson } from "../../../src/domain/canonical";
import {
  PreparationPlanV1,
  Step2DraftV1,
} from "../../../src/domain/step2";
import type { Step2SnapshotFact } from "../../../src/domain/step2Claims";
import {
  PlanReplyV2,
  PlanValidationV2,
  PreparationInputV2,
  PreparationProposalV2,
  PreparationPlanV2,
  Step2DraftOperationV2,
  Step2DraftV2,
  Step2EditedInputsV2,
  Step2PolicyVersionsV2,
  Step2ValidationV2,
  Step2ProvenanceEntryV2,
  ValidateDraftBodyV2,
  ValidateDraftReplyV2,
  WorkspacePutV3,
  deriveCorrectionSegments,
  deriveEligibleRoles,
  deriveSegmentProvenance,
  isMachineVerified,
  PROVENANCE_REVIEW_LABELS,
  type PreparationPlanV2 as PreparationPlanV2Type,
} from "../../../src/domain/step2Correction";
import {
  correctionDraftHashFor,
  correctionDraftHashMatches,
  correctionManifestHashFor,
  correctionPlanHashFor,
  correctionVerifiedCoverage,
  hashStep2CorrectionWorkflowInput,
  step2CorrectionPolicies,
  validateCorrectionSegments,
  verifyCorrectionCoverage,
} from "../../../src/tailoring/step2CorrectionPolicy";
import { draftHashFor } from "../../../src/tailoring/step2policy";
import { loadPmExpected, loadPmProfile, pmPlan } from "./s2a-world";

/**
 * WO-1.3-S2-CP-A / S2CPA1–S2CPA3: the correction contracts are
 * strict, exhaustive, and byte-stable. New schemas accept valid
 * bounded inputs and reject trust fields at provider/public
 * boundaries; v1 bytes parse byte-identically; provenance
 * derivation, eligible-role derivation, priority linkage, and
 * selected-summary-only anchors behave per the contract.
 */

const JOB = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OP = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const OP2 = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const PREP_ID = "33333333-3333-4333-8333-333333333333";
const EXTRACTION_ID = "44444444-4444-4444-8444-444444444444";
const PROFILE_VERSION_ID = "55555555-5555-4555-8555-555555555555";
const T0 = "2026-09-18T12:00:00.000Z";
const H = (ch: string): string => ch.repeat(64);
const P1 = H("a");
const P2 = H("b");
const P3 = H("c");
const P4 = H("d");

const MASTER_SUMMARY = "Product leader with discovery and pricing wins.";
const DISCOVERY_TEXT = "Led customer discovery with 40+ B2B SaaS buyers.";
const PRICING_TEXT = "Shipped usage-based pricing lifting conversion 12%.";
const EXPERIMENT_TEXT = "Defined experimentation standards adopted by 6 teams.";
const TRANSFER_TEXT = "Mentored junior product managers across the company.";
const ANGLE1_TEXT = "Discovery-led PM driving growth from buyer interviews.";
const ANGLE2_TEXT = "Pricing PM lifting conversion through packaging.";

function planFixture(): Record<string, unknown> {
  return {
    schemaVersion: "step2-plan/v2",
    planId: PLAN_ID,
    preparationId: PREP_ID,
    extractionId: EXTRACTION_ID,
    jdHash: H("e"),
    profileVersionId: PROFILE_VERSION_ID,
    evidenceHash: H("f"),
    masterProjectionHash: H("0"),
    priorities: [
      {
        priorityId: P1,
        quote: { text: "customer discovery", startByte: 10, endByte: 28 },
        count: 3,
        category: "Research",
        importance: "required",
        support: "supported",
        factIds: ["f-discovery"],
      },
      {
        priorityId: P2,
        quote: { text: "pricing strategy", startByte: 40, endByte: 56 },
        count: 2,
        category: "Commercial",
        importance: "required",
        support: "supported",
        factIds: ["f-pricing"],
      },
      {
        priorityId: P3,
        quote: { text: "NetSuite administration", startByte: 60, endByte: 85 },
        count: 1,
        category: "Systems",
        importance: "required",
        support: "gap",
        factIds: [],
      },
      {
        priorityId: P4,
        quote: { text: "experimentation standards", startByte: 90, endByte: 116 },
        count: 2,
        category: "Process",
        importance: "preferred",
        support: "supported",
        factIds: ["f-experiment"],
      },
    ],
    featuredPriorityIds: [P1, P2],
    positioning: {
      keepMasterSummary: MASTER_SUMMARY,
      angles: [
        {
          angleId: "angle-1",
          title: "Discovery-led growth",
          summaryText: ANGLE1_TEXT,
          factIds: ["f-discovery"],
          priorityIds: [P1],
        },
        {
          angleId: "angle-2",
          title: "Pricing-led growth",
          summaryText: ANGLE2_TEXT,
          factIds: ["f-pricing"],
          priorityIds: [P2],
        },
      ],
    },
    suggestions: [
      {
        suggestionId: "sug-001",
        roleId: "emp-harbor",
        text: DISCOVERY_TEXT,
        factIds: ["f-discovery"],
        priorityIds: [P1],
        usable: true,
        unusableReason: null,
      },
      {
        suggestionId: "sug-002",
        roleId: "emp-beacon",
        text: EXPERIMENT_TEXT,
        factIds: ["f-experiment"],
        priorityIds: [P4],
        usable: true,
        unusableReason: null,
      },
    ],
    rationale: "Fixture v2 plan.",
  };
}

function parsedPlan(): PreparationPlanV2Type {
  return PreparationPlanV2.parse(planFixture());
}

function draftFixture(): Record<string, unknown> {
  return {
    schemaVersion: "step2-draft/v2",
    planId: PLAN_ID,
    planHash: H("1"),
    summaryText: MASTER_SUMMARY,
    summaryOrigin: "master",
    operations: [
      {
        op: "add",
        operationId: OP,
        suggestionId: "sug-001",
        roleId: "emp-harbor",
        editedText: null,
      },
    ],
  };
}

function verdictFixture(): Record<string, unknown> {
  return {
    schemaVersion: "step2-validation/v2",
    policyVersion: "step2-claims/2",
    planId: PLAN_ID,
    planHash: H("1"),
    draftHash: H("2"),
    segments: [
      {
        segmentId: "summary",
        kind: "summary",
        roleId: null,
        origin: { kind: "master-summary" },
        anchorFactIds: [],
        priorityIds: [],
        textHash: H("3"),
        normalizedHash: H("4"),
        provenance: "VERIFIED_SOURCE",
        structural: { ok: true, reason: null },
        match: "exact-master",
        reason: null,
      },
      {
        segmentId: `op:${OP}`,
        kind: "bullet",
        roleId: "emp-harbor",
        origin: { kind: "suggestion", suggestionId: "sug-001" },
        anchorFactIds: ["f-discovery"],
        priorityIds: [P1],
        textHash: H("5"),
        normalizedHash: H("6"),
        provenance: "USER_ACCEPTED_AI",
        structural: { ok: true, reason: null },
        match: "exact-plan",
        reason: null,
      },
    ],
    provenanceCounts: { verifiedSource: 1, userAcceptedAi: 1, userEdited: 0 },
    budget: {
      summaryChars: 44,
      perRoleCounts: [{ roleId: "emp-harbor", bullets: 3 }],
      totalBullets: 4,
      exceeded: false,
    },
    validatedAt: T0,
  };
}

function manifestFixture(): Record<string, unknown>[] {
  return [
    {
      segmentId: "summary",
      kind: "summary",
      roleId: null,
      origin: { kind: "master-summary" },
      anchorFactIds: [],
      priorityIds: [],
      textHash: H("3"),
      normalizedHash: H("4"),
      provenance: "VERIFIED_SOURCE",
      sourceOperationId: null,
    },
  ];
}

function snapshotFacts(): Step2SnapshotFact[] {
  const approved = (factId: string, statement: string, employmentId: string | null): Step2SnapshotFact => ({
    factId,
    statement,
    verification: "APPROVED",
    profileVersionId: PROFILE_VERSION_ID,
    employmentId,
  });
  return [
    approved("f-discovery", DISCOVERY_TEXT, "emp-harbor"),
    approved("f-pricing", PRICING_TEXT, "emp-harbor"),
    approved("f-experiment", EXPERIMENT_TEXT, "emp-beacon"),
    approved("f-transfer", TRANSFER_TEXT, null),
    {
      factId: "f-pending",
      statement: "Draft claim awaiting review.",
      verification: "PENDING",
      profileVersionId: PROFILE_VERSION_ID,
      employmentId: "emp-harbor",
    },
  ];
}

function masterBullets(): Array<{ roleId: string; factId: string; text: string }> {
  return [
    { roleId: "emp-harbor", factId: "f-discovery", text: DISCOVERY_TEXT },
    { roleId: "emp-harbor", factId: "f-pricing", text: PRICING_TEXT },
    { roleId: "emp-beacon", factId: "f-experiment", text: EXPERIMENT_TEXT },
  ];
}

const EMPLOYMENTS = [
  { id: "emp-harbor", company: "Harbor Analytics" },
  { id: "emp-beacon", company: "Beacon Tools" },
];

const TRUST_EXTRAS = [
  "actor",
  "now",
  "provenance",
  "accepted",
  "userAuthored",
  "eligibleRoleIds",
  "verdict",
  "verified",
  "score",
  "coverage",
];

describe("S2CPA1 strict correction schemas", () => {
  const plan = planFixture();
  const draft = draftFixture();
  const validation = verdictFixture();
  const table: Array<{ name: string; schema: z.ZodType; valid: unknown }> = [
    { name: "PreparationPlanV2", schema: PreparationPlanV2, valid: plan },
    { name: "Step2DraftV2", schema: Step2DraftV2, valid: draft },
    { name: "Step2ValidationV2", schema: Step2ValidationV2, valid: validation },
    {
      name: "WorkspacePutV3",
      schema: WorkspacePutV3,
      valid: {
        schemaVersion: "tailoring-workspace/v3",
        extractionId: EXTRACTION_ID,
        profileId: "pm",
        profileVersionId: PROFILE_VERSION_ID,
        requestKind: "INITIAL",
        parentVersionId: null,
        revisionNote: null,
        planId: PLAN_ID,
        planHash: H("1"),
        recommendationHash: null,
        draft,
      },
    },
    {
      name: "ValidateDraftBodyV2",
      schema: ValidateDraftBodyV2,
      valid: {
        schemaVersion: "step2-validate-draft/v2",
        workspaceRevision: 2,
        summaryText: MASTER_SUMMARY,
        summaryOrigin: "master",
        operations: (draft as { operations: unknown[] }).operations,
      },
    },
    {
      name: "ValidateDraftReplyV2",
      schema: ValidateDraftReplyV2,
      valid: { ok: true, validationId: OP, validation },
    },
    {
      name: "PlanReplyV2",
      schema: PlanReplyV2,
      valid: {
        ok: true,
        plan,
        eligibleRoles: [
          { suggestionId: "sug-001", eligibleRoleIds: ["emp-harbor"] },
          { suggestionId: "sug-002", eligibleRoleIds: ["emp-beacon"] },
        ],
        planHash: H("1"),
        validatedAt: T0,
        supersedesPlanId: null,
      },
    },
    {
      name: "PreparationProposalV2",
      schema: PreparationProposalV2,
      valid: {
        schemaVersion: "preparation-proposal/v2",
        jdSnapshotId: "jd-1",
        candidateSnapshotId: "cand-1",
        priorities: [
          {
            quote: { text: "customer discovery", startByte: 10, endByte: 28 },
            count: 3,
            category: "Research",
            importance: "required",
            matchStatus: "matched",
            factIds: ["f-discovery"],
          },
        ],
        angles: [
          {
            title: "Discovery-led growth",
            summaryText: ANGLE1_TEXT,
            factIds: ["f-discovery"],
            priorityIds: [P1],
          },
        ],
        suggestions: [
          {
            roleId: "emp-harbor",
            text: DISCOVERY_TEXT,
            factIds: ["f-discovery"],
            priorityIds: [P1],
          },
        ],
        rationale: "Grounded.",
      },
    },
    {
      name: "PlanValidationV2",
      schema: PlanValidationV2,
      valid: {
        schemaVersion: "step2-plan-validation/v2",
        droppedPriorities: [],
        angles: [{ angleId: "angle-1", keptPriorityIds: [P1], droppedPriorityIds: [] }],
        suggestions: [
          {
            suggestionId: "sug-001",
            usable: true,
            unusableReason: null,
            keptFactIds: ["f-discovery"],
            droppedFactIds: [],
            keptPriorityIds: [P1],
            droppedPriorityIds: [],
            eligibleRoleIds: ["emp-harbor"],
          },
        ],
      },
    },
    {
      name: "Step2EditedInputsV2",
      schema: Step2EditedInputsV2,
      valid: {
        schemaVersion: "step2-edited-inputs/v2",
        planId: PLAN_ID,
        summaryText: MASTER_SUMMARY,
        summaryOrigin: "master",
        operations: (draft as { operations: unknown[] }).operations,
        provenanceManifest: manifestFixture(),
      },
    },
    {
      name: "Step2PolicyVersionsV2",
      schema: Step2PolicyVersionsV2,
      valid: {
        schemaVersion: "step2-policy-versions/v2",
        claims: "step2-claims/2",
        master: "step2-master-bullets/1",
        prompt: "prepare-prompt/v2",
      },
    },
    {
      name: "PreparationInputV2",
      schema: PreparationInputV2,
      valid: {
        schemaVersion: "preparation-input/v2",
        promptVersion: "prepare-prompt/v2",
        jobId: JOB,
        jobTitle: "Product Manager",
        company: "Harbor Analytics",
        extractionId: EXTRACTION_ID,
        jdSnapshotId: "jd-1",
        jdText: "customer discovery and pricing strategy",
        candidateSnapshotId: "cand-1",
        profile: loadPmProfile(),
        approvedFactIds: ["f-discovery"],
        masterBullets: [{ roleId: "emp-harbor", factId: "f-discovery", text: DISCOVERY_TEXT }],
        budgets: { priorities: 20, suggestions: 10, angles: 2 },
      },
    },
  ];
  for (const row of table) {
    it(`${row.name} accepts its valid shape`, () => {
      expect(row.schema.safeParse(row.valid).success).toBe(true);
    });
    it(`${row.name} rejects trust fields at the boundary`, () => {
      for (const extra of TRUST_EXTRAS) {
        const tainted = { ...(row.valid as Record<string, unknown>), [extra]: "x" };
        expect(row.schema.safeParse(tainted).success, `extra '${extra}'`).toBe(false);
      }
    });
  }

  it("provider proposals reject priority-less angles and suggestions", () => {
    const base = {
      schemaVersion: "preparation-proposal/v2",
      jdSnapshotId: "jd-1",
      candidateSnapshotId: "cand-1",
      priorities: [],
      rationale: "Empty.",
    };
    const angleLess = {
      ...base,
      angles: [{ title: "T", summaryText: "S", factIds: ["f-discovery"], priorityIds: [] }],
      suggestions: [],
    };
    const suggestionLess = {
      ...base,
      angles: [],
      suggestions: [{ roleId: "emp-harbor", text: "T", factIds: ["f-discovery"], priorityIds: [] }],
    };
    expect(PreparationProposalV2.safeParse(angleLess).success).toBe(false);
    expect(PreparationProposalV2.safeParse(suggestionLess).success).toBe(false);
  });

  it("v2 plans reject foreign, duplicate, and missing priority links", () => {
    const foreign = structuredClone(planFixture()) as Record<string, unknown>;
    ((foreign["suggestions"] as Record<string, unknown>[])[0] as Record<string, unknown>)["priorityIds"] = [H("9")];
    expect(PreparationPlanV2.safeParse(foreign).success).toBe(false);
    const duplicate = structuredClone(planFixture()) as Record<string, unknown>;
    ((duplicate["positioning"] as Record<string, unknown>)["angles"] as Record<string, unknown>[])[0]["priorityIds"] = [P1, P1];
    expect(PreparationPlanV2.safeParse(duplicate).success).toBe(false);
    const missing = structuredClone(planFixture()) as Record<string, unknown>;
    ((missing["suggestions"] as Record<string, unknown>[])[1] as Record<string, unknown>)["priorityIds"] = [];
    expect(PreparationPlanV2.safeParse(missing).success).toBe(false);
  });

  it("v2 plans keep the v1 uniqueness refinements", () => {
    const dupePriority = structuredClone(planFixture()) as Record<string, unknown>;
    ((dupePriority["priorities"] as Record<string, unknown>[])[1] as Record<string, unknown>)["priorityId"] = P1;
    expect(PreparationPlanV2.safeParse(dupePriority).success).toBe(false);
    const dupeSuggestion = structuredClone(planFixture()) as Record<string, unknown>;
    ((dupeSuggestion["suggestions"] as Record<string, unknown>[])[1] as Record<string, unknown>)["suggestionId"] = "sug-001";
    expect(PreparationPlanV2.safeParse(dupeSuggestion).success).toBe(false);
    const badFeatured = structuredClone(planFixture()) as Record<string, unknown>;
    badFeatured["featuredPriorityIds"] = [H("9")];
    expect(PreparationPlanV2.safeParse(badFeatured).success).toBe(false);
  });

  it("v2 drafts reject duplicate operation ids and replace-XOR violations", () => {
    const dupe = structuredClone(draftFixture()) as Record<string, unknown>;
    const ops = dupe["operations"] as Record<string, unknown>[];
    ops.push({ ...ops[0] });
    expect(Step2DraftV2.safeParse(dupe).success).toBe(false);
    const both = {
      op: "replace",
      operationId: OP2,
      targetFactId: "f-discovery",
      roleId: "emp-harbor",
      suggestionId: "sug-001",
      editedText: "Free text.",
    };
    expect(Step2DraftOperationV2.safeParse(both).success).toBe(false);
    const neither = { ...both, suggestionId: null, editedText: null };
    expect(Step2DraftOperationV2.safeParse(neither).success).toBe(false);
  });

  it("v2 drafts reject the retired 'edited' summary source", () => {
    const retired = structuredClone(draftFixture()) as Record<string, unknown>;
    retired["summaryOrigin"] = "edited";
    expect(Step2DraftV2.safeParse(retired).success).toBe(false);
  });

  it("v2 validations require counts equal to segment tallies", () => {
    const skewed = structuredClone(verdictFixture()) as Record<string, unknown>;
    skewed["provenanceCounts"] = { verifiedSource: 2, userAcceptedAi: 0, userEdited: 0 };
    expect(Step2ValidationV2.safeParse(skewed).success).toBe(false);
  });

  it("structural results are ok/XOR reason", () => {
    const both = structuredClone(verdictFixture()) as Record<string, unknown>;
    ((both["segments"] as Record<string, unknown>[])[0] as Record<string, unknown>)["structural"] = {
      ok: true,
      reason: "FOREIGN_ROLE",
    };
    expect(Step2ValidationV2.safeParse(both).success).toBe(false);
    const neither = structuredClone(verdictFixture()) as Record<string, unknown>;
    ((neither["segments"] as Record<string, unknown>[])[0] as Record<string, unknown>)["structural"] = {
      ok: false,
      reason: null,
    };
    expect(Step2ValidationV2.safeParse(neither).success).toBe(false);
  });

  it("plan replies require one eligible-role entry per suggestion", () => {
    const short = {
      ok: true,
      plan: planFixture(),
      eligibleRoles: [{ suggestionId: "sug-001", eligibleRoleIds: ["emp-harbor"] }],
      planHash: H("1"),
      validatedAt: T0,
      supersedesPlanId: null,
    };
    expect(PlanReplyV2.safeParse(short).success).toBe(false);
    const foreign = {
      ok: true,
      plan: planFixture(),
      eligibleRoles: [
        { suggestionId: "sug-001", eligibleRoleIds: ["emp-harbor"] },
        { suggestionId: "sug-999", eligibleRoleIds: ["emp-beacon"] },
      ],
      planHash: H("1"),
      validatedAt: T0,
      supersedesPlanId: null,
    };
    expect(PlanReplyV2.safeParse(foreign).success).toBe(false);
  });

  it("manifest entries require unique segment ids", () => {
    const dupe = {
      schemaVersion: "step2-edited-inputs/v2",
      planId: PLAN_ID,
      summaryText: MASTER_SUMMARY,
      summaryOrigin: "master",
      operations: [],
      provenanceManifest: [...manifestFixture(), ...manifestFixture()],
    };
    expect(Step2EditedInputsV2.safeParse(dupe).success).toBe(false);
  });

  it("v1 bytes parse byte-identically and never as v2", () => {
    const expected = loadPmExpected();
    const v1 = pmPlan(expected);
    const bytes = canonicalJson(expected.plan);
    expect(PreparationPlanV1.safeParse(JSON.parse(bytes) as unknown).success).toBe(true);
    expect(canonicalJson(v1)).toBe(canonicalJson(JSON.parse(bytes) as unknown));
    expect(PreparationPlanV2.safeParse(JSON.parse(bytes) as unknown).success).toBe(false);
    expect(PreparationPlanV1.safeParse(planFixture()).success).toBe(false);
  });

  it("v1 drafts parse byte-identically and never as v2", () => {
    const v1 = {
      schemaVersion: "step2-draft/v1",
      planId: PLAN_ID,
      planHash: H("1"),
      summaryText: MASTER_SUMMARY,
      summarySource: "master",
      operations: [
        { op: "add", operationId: OP, suggestionId: "sug-001", roleId: "emp-harbor", editedText: null },
      ],
    };
    expect(Step2DraftV1.safeParse(v1).success).toBe(true);
    expect(canonicalJson(Step2DraftV1.parse(v1))).toBe(canonicalJson(v1));
    expect(Step2DraftV2.safeParse(v1).success).toBe(false);
    expect(Step2DraftV1.safeParse(draftFixture()).success).toBe(false);
  });

  it("v1 draft digests recompute byte-identically (untouched history)", () => {
    const v1 = Step2DraftV1.parse({
      schemaVersion: "step2-draft/v1",
      planId: PLAN_ID,
      planHash: H("1"),
      summaryText: MASTER_SUMMARY,
      summarySource: "master",
      operations: [
        { op: "add", operationId: OP, suggestionId: "sug-001", roleId: "emp-harbor", editedText: null },
      ],
    });
    expect(draftHashFor(v1)).toBe(draftHashFor({ ...v1 }));
    expect(draftHashFor(v1)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("correction digests are canonical and namespaced apart from v1", () => {
    const plan = parsedPlan();
    const reordered = PreparationPlanV2.parse(
      Object.fromEntries(Object.entries(plan).reverse()) as unknown,
    );
    expect(correctionPlanHashFor(reordered)).toBe(correctionPlanHashFor(plan));
    const draft = Step2DraftV2.parse(draftFixture());
    expect(correctionDraftHashFor(draft)).toMatch(/^[0-9a-f]{64}$/);
    expect(correctionDraftHashMatches(H("1"), {
      planId: draft.planId,
      planHash: draft.planHash,
      summaryText: draft.summaryText,
      summaryOrigin: draft.summaryOrigin,
      operations: draft.operations,
    })).toBe(false);
    expect(correctionDraftHashMatches(correctionDraftHashFor(draft), {
      planId: draft.planId,
      planHash: draft.planHash,
      summaryText: draft.summaryText,
      summaryOrigin: draft.summaryOrigin,
      operations: draft.operations,
    })).toBe(true);
    // v1 and v2 draft digests cover different key sets: equal logical
    // content never collides across the namespace boundary.
    const v1 = Step2DraftV1.parse({
      schemaVersion: "step2-draft/v1",
      planId: PLAN_ID,
      planHash: H("1"),
      summaryText: MASTER_SUMMARY,
      summarySource: "master",
      operations: [
        { op: "add", operationId: OP, suggestionId: "sug-001", roleId: "emp-harbor", editedText: null },
      ],
    });
    expect(correctionDraftHashFor(draft)).not.toBe(draftHashFor(v1));
  });

  it("manifest and workflow-input hashes bind provenance to the freeze", () => {
    const manifest = manifestFixture().map((entry) => Step2ProvenanceEntryV2.parse(entry));
    const hash = correctionManifestHashFor(manifest);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const reordered = correctionManifestHashFor([...manifest].reverse());
    expect(manifest.length).toBe(1);
    expect(reordered).toBe(hash);
    const policies = step2CorrectionPolicies();
    expect(policies).toEqual({
      schemaVersion: "step2-policy-versions/v2",
      claims: "step2-claims/2",
      master: "step2-master-bullets/1",
      prompt: "prepare-prompt/v2",
    });
    const workflow = hashStep2CorrectionWorkflowInput({
      workspaceRevision: 3,
      planId: PLAN_ID,
      planHash: H("1"),
      draftHash: H("2"),
      validationId: OP,
      provenanceManifestHash: hash,
      candidateSnapshotId: "cand-1",
      masterText: "Master text.",
      masterTextHash: H("7"),
      projectionVersion: "master-text/1",
      policies,
    });
    expect(workflow).toMatch(/^[0-9a-f]{64}$/);
    const tampered = hashStep2CorrectionWorkflowInput({
      workspaceRevision: 3,
      planId: PLAN_ID,
      planHash: H("1"),
      draftHash: H("2"),
      validationId: OP,
      provenanceManifestHash: H("8"),
      candidateSnapshotId: "cand-1",
      masterText: "Master text.",
      masterTextHash: H("7"),
      projectionVersion: "master-text/1",
      policies,
    });
    expect(tampered).not.toBe(workflow);
  });
});

describe("S2CPA2 exhaustive provenance table", () => {
  const masterOrigin = { kind: "master-bullet", factId: "f-discovery" } as const;
  const aiOrigin = { kind: "suggestion", suggestionId: "sug-001" } as const;

  it("labels provenance for review and counts only verified source", () => {
    expect(PROVENANCE_REVIEW_LABELS).toEqual({
      VERIFIED_SOURCE: "Verified source",
      USER_ACCEPTED_AI: "AI suggestion · accepted",
      USER_EDITED: "User edit",
    });
    expect(isMachineVerified("VERIFIED_SOURCE")).toBe(true);
    expect(isMachineVerified("USER_ACCEPTED_AI")).toBe(false);
    expect(isMachineVerified("USER_EDITED")).toBe(false);
  });

  it("exact untouched master text with intact lineage is verified source", () => {
    expect(
      deriveSegmentProvenance({
        origin: masterOrigin,
        originText: DISCOVERY_TEXT,
        text: DISCOVERY_TEXT,
        userEdited: false,
        originUsable: true,
        lineageIntact: true,
      }),
    ).toBe("VERIFIED_SOURCE");
  });

  it("exact untouched usable AI text is user-accepted AI, not verified", () => {
    expect(
      deriveSegmentProvenance({
        origin: aiOrigin,
        originText: DISCOVERY_TEXT,
        text: DISCOVERY_TEXT,
        userEdited: false,
        originUsable: true,
        lineageIntact: true,
      }),
    ).toBe("USER_ACCEPTED_AI");
  });

  it("any saved text change is a user edit", () => {
    const edited = `${DISCOVERY_TEXT} Now with 300% more revenue.`;
    expect(
      deriveSegmentProvenance({
        origin: masterOrigin,
        originText: DISCOVERY_TEXT,
        text: edited,
        userEdited: true,
        originUsable: true,
        lineageIntact: true,
      }),
    ).toBe("USER_EDITED");
    expect(
      deriveSegmentProvenance({
        origin: aiOrigin,
        originText: DISCOVERY_TEXT,
        text: edited,
        userEdited: true,
        originUsable: true,
        lineageIntact: true,
      }),
    ).toBe("USER_EDITED");
  });

  it("unusable AI origins and broken lineage can never verify", () => {
    expect(
      deriveSegmentProvenance({
        origin: aiOrigin,
        originText: DISCOVERY_TEXT,
        text: DISCOVERY_TEXT,
        userEdited: false,
        originUsable: false,
        lineageIntact: true,
      }),
    ).toBe("USER_EDITED");
    expect(
      deriveSegmentProvenance({
        origin: masterOrigin,
        originText: DISCOVERY_TEXT,
        text: DISCOVERY_TEXT,
        userEdited: false,
        originUsable: true,
        lineageIntact: false,
      }),
    ).toBe("USER_EDITED");
  });

  it("normalization-only differences are not edits; recasing is", () => {
    expect(
      deriveSegmentProvenance({
        origin: masterOrigin,
        originText: DISCOVERY_TEXT,
        text: `  ${DISCOVERY_TEXT}\n`,
        userEdited: false,
        originUsable: true,
        lineageIntact: true,
      }),
    ).toBe("VERIFIED_SOURCE");
    expect(
      deriveSegmentProvenance({
        origin: masterOrigin,
        originText: DISCOVERY_TEXT,
        text: DISCOVERY_TEXT.toUpperCase(),
        userEdited: true,
        originUsable: true,
        lineageIntact: true,
      }),
    ).toBe("USER_EDITED");
  });

  function validateWith(summaryText: string, summaryOrigin: "master" | "angle-1" | "angle-2", ops: Parameters<typeof validateCorrectionSegments>[0]["operations"]) {
    const plan = parsedPlan();
    const derived = deriveCorrectionSegments({
      plan,
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      summaryText,
      summaryOrigin,
      operations: ops,
    });
    const draftHash = correctionDraftHashFor(
      Step2DraftV2.parse({
        schemaVersion: "step2-draft/v2",
        planId: PLAN_ID,
        planHash: H("1"),
        summaryText,
        summaryOrigin,
        operations: ops,
      }),
    );
    return validateCorrectionSegments({
      segments: derived,
      plan,
      planHash: H("1"),
      draftHash,
      boundProfileVersionId: PROFILE_VERSION_ID,
      snapshotFacts: snapshotFacts(),
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      employments: EMPLOYMENTS,
      versionCreatedAt: "2026-09-18T10:00:00.000Z",
      planAcceptedAt: "2026-09-18T11:00:00.000Z",
      now: T0,
      validatedAt: T0,
      summaryText,
      operations: ops,
    });
  }

  it("untouched master plus accepted AI validate structurally sound", () => {
    const validation = validateWith(MASTER_SUMMARY, "master", [
      { op: "add", operationId: OP, suggestionId: "sug-001", roleId: "emp-harbor", editedText: null },
    ]);
    expect(validation.segments.map((segment) => segment.provenance)).toEqual([
      "VERIFIED_SOURCE",
      "USER_ACCEPTED_AI",
    ]);
    expect(validation.segments.every((segment) => segment.structural.ok)).toBe(true);
    expect(validation.provenanceCounts).toEqual({ verifiedSource: 1, userAcceptedAi: 1, userEdited: 0 });
    expect(validation.budget.exceeded).toBe(false);
  });

  it("user-edited metric, technology, and responsibility text stays structurally valid", () => {
    const edited = `${DISCOVERY_TEXT} using NetSuite, owning P&L, lifting revenue 300%.`;
    const validation = validateWith(edited, "master", [
      { op: "add", operationId: OP, suggestionId: "sug-001", roleId: "emp-harbor", editedText: edited },
    ]);
    const verdicts = new Map(validation.segments.map((segment) => [segment.segmentId, segment]));
    expect(verdicts.get("summary")?.provenance).toBe("USER_EDITED");
    expect(verdicts.get(`op:${OP}`)?.provenance).toBe("USER_EDITED");
    expect(validation.segments.every((segment) => segment.structural.ok)).toBe(true);
    expect(validation.provenanceCounts.userEdited).toBe(2);
    const coverage = verifyCorrectionCoverage({
      derived: deriveCorrectionSegments({
        plan: parsedPlan(),
        master: masterBullets(),
        masterSummary: MASTER_SUMMARY,
        summaryText: edited,
        summaryOrigin: "master",
        operations: [
          { op: "add", operationId: OP, suggestionId: "sug-001", roleId: "emp-harbor", editedText: edited },
        ],
      }),
      validation,
    });
    expect(coverage.covered).toBe(true);
    expect(coverage.allStructuralOk).toBe(true);
  });

  it("coverage partitions verified from non-verified for assessment", () => {
    const validation = validateWith(`Edited ${MASTER_SUMMARY}`, "master", [
      { op: "add", operationId: OP, suggestionId: "sug-001", roleId: "emp-harbor", editedText: null },
    ]);
    const { verifiedSegmentIds, nonVerifiedSegmentIds } = correctionVerifiedCoverage({ validation });
    expect(verifiedSegmentIds).toEqual([]);
    expect(nonVerifiedSegmentIds.sort()).toEqual(["summary", `op:${OP}`].sort());
  });

  it("derivation manifests record audit matches without verifying user text", () => {
    const plan = parsedPlan();
    const derived = deriveCorrectionSegments({
      plan,
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      summaryText: MASTER_SUMMARY,
      summaryOrigin: "master",
      operations: [],
    });
    const draftHash = correctionDraftHashFor(
      Step2DraftV2.parse({
        schemaVersion: "step2-draft/v2",
        planId: PLAN_ID,
        planHash: H("1"),
        summaryText: MASTER_SUMMARY,
        summaryOrigin: "master",
        operations: [],
      }),
    );
    const validation = validateCorrectionSegments({
      segments: derived,
      plan,
      planHash: H("1"),
      draftHash,
      boundProfileVersionId: PROFILE_VERSION_ID,
      snapshotFacts: snapshotFacts(),
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      employments: EMPLOYMENTS,
      versionCreatedAt: "2026-09-18T10:00:00.000Z",
      planAcceptedAt: "2026-09-18T11:00:00.000Z",
      now: T0,
      validatedAt: T0,
      summaryText: MASTER_SUMMARY,
      operations: [],
      derivation: { finalText: MASTER_SUMMARY, factIds: [] },
    });
    expect(validation.segments).toHaveLength(1);
    expect(validation.segments[0]?.provenance).toBe("VERIFIED_SOURCE");
    expect(validation.segments[0]?.match).toBe("derivation");
  });
});

describe("S2CPA3 linkage, anchors, and eligible roles", () => {
  it("derives single-owner eligibility from employment-owned anchors", () => {
    expect(
      deriveEligibleRoles({
        citedFactIds: ["f-discovery", "f-pricing"],
        employmentByFactId: new Map([
          ["f-discovery", "emp-harbor"],
          ["f-pricing", "emp-harbor"],
        ]),
        employmentIds: ["emp-harbor", "emp-beacon"],
      }),
    ).toEqual({ eligibleRoleIds: ["emp-harbor"], ownership: "single" });
  });

  it("derives transferable eligibility from unowned anchors", () => {
    expect(
      deriveEligibleRoles({
        citedFactIds: ["f-transfer"],
        employmentByFactId: new Map([["f-transfer", null]]),
        employmentIds: ["emp-harbor", "emp-beacon"],
      }),
    ).toEqual({ eligibleRoleIds: ["emp-harbor", "emp-beacon"], ownership: "transferable" });
  });

  it("fails closed on mixed and unknown ownership", () => {
    expect(
      deriveEligibleRoles({
        citedFactIds: ["f-discovery", "f-experiment"],
        employmentByFactId: new Map([
          ["f-discovery", "emp-harbor"],
          ["f-experiment", "emp-beacon"],
        ]),
        employmentIds: ["emp-harbor", "emp-beacon"],
      }),
    ).toEqual({ eligibleRoleIds: [], ownership: "mixed" });
    expect(
      deriveEligibleRoles({
        citedFactIds: ["f-ghost"],
        employmentByFactId: new Map(),
        employmentIds: ["emp-harbor", "emp-beacon"],
      }),
    ).toEqual({ eligibleRoleIds: [], ownership: "unknown" });
  });

  it("transferable anchors do not dilute single-owner eligibility", () => {
    expect(
      deriveEligibleRoles({
        citedFactIds: ["f-discovery", "f-transfer"],
        employmentByFactId: new Map([
          ["f-discovery", "emp-harbor"],
          ["f-transfer", null],
        ]),
        employmentIds: ["emp-harbor", "emp-beacon"],
      }),
    ).toEqual({ eligibleRoleIds: ["emp-harbor"], ownership: "single" });
  });

  it("token overlap and bare fact ids can never verify prose", () => {
    const reworded = "Buyers B2B 40+ with discovery customer Led.";
    expect(
      deriveSegmentProvenance({
        origin: { kind: "suggestion", suggestionId: "sug-001" },
        originText: DISCOVERY_TEXT,
        text: reworded,
        userEdited: true,
        originUsable: true,
        lineageIntact: true,
      }),
    ).toBe("USER_EDITED");
    expect(
      deriveSegmentProvenance({
        origin: { kind: "master-bullet", factId: "f-discovery" },
        originText: DISCOVERY_TEXT,
        text: "Completely unrelated sentence about NetSuite ownership.",
        userEdited: true,
        originUsable: true,
        lineageIntact: true,
      }),
    ).toBe("USER_EDITED");
  });

  it("summary anchors come only from the chosen angle, never the plan union", () => {
    const plan = parsedPlan();
    const derived = deriveCorrectionSegments({
      plan,
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      summaryText: ANGLE1_TEXT,
      summaryOrigin: "angle-1",
      operations: [],
    });
    expect(derived).toHaveLength(1);
    expect(derived[0]?.anchorFactIds).toEqual(["f-discovery"]);
    expect(derived[0]?.priorityIds).toEqual([P1]);
    expect(derived[0]?.origin).toEqual({ kind: "angle", angleId: "angle-1" });
    expect(derived[0]?.userEdited).toBe(false);
  });

  it("master summaries carry no fact anchors; edits retain the origin", () => {
    const plan = parsedPlan();
    const derived = deriveCorrectionSegments({
      plan,
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      summaryText: `${MASTER_SUMMARY} Personally I shipped NetSuite.`,
      summaryOrigin: "master",
      operations: [],
    });
    expect(derived).toHaveLength(1);
    expect(derived[0]?.anchorFactIds).toEqual([]);
    expect(derived[0]?.origin).toEqual({ kind: "master-summary" });
    expect(derived[0]?.userEdited).toBe(true);
  });

  it("empty summaries produce no segment", () => {
    const derived = deriveCorrectionSegments({
      plan: parsedPlan(),
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      summaryText: "",
      summaryOrigin: "master",
      operations: [],
    });
    expect(derived).toEqual([]);
  });

  it("bullet segments retain suggestion anchors, priorities, and edit state", () => {
    const edited = `${DISCOVERY_TEXT} Extra user sentence.`;
    const derived = deriveCorrectionSegments({
      plan: parsedPlan(),
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      summaryText: MASTER_SUMMARY,
      summaryOrigin: "master",
      operations: [
        { op: "add", operationId: OP, suggestionId: "sug-001", roleId: "emp-harbor", editedText: null },
        { op: "add", operationId: OP2, suggestionId: "sug-002", roleId: "emp-beacon", editedText: edited },
        { op: "exclude", operationId: "33333333-3333-4333-8333-333333333333", targetFactId: "f-pricing" },
      ],
    });
    expect(derived.map((segment) => segment.segmentId)).toEqual(["summary", `op:${OP}`, `op:${OP2}`]);
    const added = derived[1];
    expect(added?.anchorFactIds).toEqual(["f-discovery"]);
    expect(added?.priorityIds).toEqual([P1]);
    expect(added?.userEdited).toBe(false);
    const editedAdd = derived[2];
    expect(editedAdd?.userEdited).toBe(true);
    expect(editedAdd?.anchorFactIds).toEqual(["f-experiment"]);
  });

  it("unknown references yield no segment", () => {
    const derived = deriveCorrectionSegments({
      plan: parsedPlan(),
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      summaryText: MASTER_SUMMARY,
      summaryOrigin: "master",
      operations: [
        { op: "add", operationId: OP, suggestionId: "sug-999", roleId: "emp-harbor", editedText: null },
      ],
    });
    expect(derived.map((segment) => segment.segmentId)).toEqual(["summary"]);
  });

  it("replace-with-text cites its target bullet and records authorship", () => {
    const derived = deriveCorrectionSegments({
      plan: parsedPlan(),
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      summaryText: MASTER_SUMMARY,
      summaryOrigin: "master",
      operations: [
        {
          op: "replace",
          operationId: OP,
          targetFactId: "f-discovery",
          roleId: "emp-harbor",
          suggestionId: null,
          editedText: "User-authored replacement text.",
        },
      ],
    });
    expect(derived).toHaveLength(2);
    expect(derived[1]?.origin).toEqual({ kind: "master-bullet", factId: "f-discovery" });
    expect(derived[1]?.anchorFactIds).toEqual(["f-discovery"]);
    expect(derived[1]?.userEdited).toBe(true);
  });

  function structuralFor(operations: Parameters<typeof validateCorrectionSegments>[0]["operations"]) {
    const plan = parsedPlan();
    const derived = deriveCorrectionSegments({
      plan,
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      summaryText: MASTER_SUMMARY,
      summaryOrigin: "master",
      operations,
    });
    const draftHash = correctionDraftHashFor(
      Step2DraftV2.parse({
        schemaVersion: "step2-draft/v2",
        planId: PLAN_ID,
        planHash: H("1"),
        summaryText: MASTER_SUMMARY,
        summaryOrigin: "master",
        operations,
      }),
    );
    return validateCorrectionSegments({
      segments: derived,
      plan,
      planHash: H("1"),
      draftHash,
      boundProfileVersionId: PROFILE_VERSION_ID,
      snapshotFacts: snapshotFacts(),
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      employments: EMPLOYMENTS,
      versionCreatedAt: "2026-09-18T10:00:00.000Z",
      planAcceptedAt: "2026-09-18T11:00:00.000Z",
      now: T0,
      validatedAt: T0,
      summaryText: MASTER_SUMMARY,
      operations,
    });
  }

  it("foreign-role suggestion instances are structurally blocked", () => {
    const validation = structuralFor([
      { op: "add", operationId: OP, suggestionId: "sug-001", roleId: "emp-beacon", editedText: null },
    ]);
    const bullet = validation.segments.find((segment) => segment.segmentId === `op:${OP}`);
    expect(bullet?.structural).toEqual({ ok: false, reason: "FOREIGN_ROLE" });
    expect(bullet?.reason).toBe("FOREIGN_ROLE");
    expect(verifyCorrectionCoverage({
      derived: deriveCorrectionSegments({
        plan: parsedPlan(),
        master: masterBullets(),
        masterSummary: MASTER_SUMMARY,
        summaryText: MASTER_SUMMARY,
        summaryOrigin: "master",
        operations: [
          { op: "add", operationId: OP, suggestionId: "sug-001", roleId: "emp-beacon", editedText: null },
        ],
      }),
      validation,
    }).allStructuralOk).toBe(false);
  });

  it("unknown roles and invalid anchors are structurally blocked", () => {
    const unknownRole = structuralFor([
      { op: "add", operationId: OP, suggestionId: "sug-001", roleId: "emp-ghost", editedText: null },
    ]);
    expect(unknownRole.segments.find((segment) => segment.segmentId === `op:${OP}`)?.structural).toEqual({
      ok: false,
      reason: "UNKNOWN_ROLE",
    });
    const plan = parsedPlan();
    plan.suggestions[0] = { ...plan.suggestions[0], factIds: ["f-ghost"] } as (typeof plan.suggestions)[number];
    const derived = deriveCorrectionSegments({
      plan,
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      summaryText: MASTER_SUMMARY,
      summaryOrigin: "master",
      operations: [
        { op: "add", operationId: OP, suggestionId: "sug-001", roleId: "emp-harbor", editedText: null },
      ],
    });
    const draftHash = correctionDraftHashFor(
      Step2DraftV2.parse({
        schemaVersion: "step2-draft/v2",
        planId: PLAN_ID,
        planHash: H("1"),
        summaryText: MASTER_SUMMARY,
        summaryOrigin: "master",
        operations: [
          { op: "add", operationId: OP, suggestionId: "sug-001", roleId: "emp-harbor", editedText: null },
        ],
      }),
    );
    const invalidAnchor = validateCorrectionSegments({
      segments: derived,
      plan,
      planHash: H("1"),
      draftHash,
      boundProfileVersionId: PROFILE_VERSION_ID,
      snapshotFacts: snapshotFacts(),
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      employments: EMPLOYMENTS,
      versionCreatedAt: "2026-09-18T10:00:00.000Z",
      planAcceptedAt: "2026-09-18T11:00:00.000Z",
      now: T0,
      validatedAt: T0,
      summaryText: MASTER_SUMMARY,
      operations: [
        { op: "add", operationId: OP, suggestionId: "sug-001", roleId: "emp-harbor", editedText: null },
      ],
    });
    expect(invalidAnchor.segments.find((segment) => segment.segmentId === `op:${OP}`)?.structural).toEqual({
      ok: false,
      reason: "INVALID_ANCHOR",
    });
  });

  it("missing and foreign priority links are structurally blocked", () => {
    const plan = parsedPlan();
    plan.suggestions[0] = { ...plan.suggestions[0], priorityIds: [] } as (typeof plan.suggestions)[number];
    const ops = [
      { op: "add", operationId: OP, suggestionId: "sug-001", roleId: "emp-harbor", editedText: null },
    ] as Parameters<typeof validateCorrectionSegments>[0]["operations"];
    const derived = deriveCorrectionSegments({
      plan,
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      summaryText: MASTER_SUMMARY,
      summaryOrigin: "master",
      operations: ops,
    });
    const draftHash = correctionDraftHashFor(
      Step2DraftV2.parse({
        schemaVersion: "step2-draft/v2",
        planId: PLAN_ID,
        planHash: H("1"),
        summaryText: MASTER_SUMMARY,
        summaryOrigin: "master",
        operations: ops,
      }),
    );
    const base = {
      plan,
      planHash: H("1"),
      draftHash,
      boundProfileVersionId: PROFILE_VERSION_ID,
      snapshotFacts: snapshotFacts(),
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      employments: EMPLOYMENTS,
      versionCreatedAt: "2026-09-18T10:00:00.000Z",
      planAcceptedAt: "2026-09-18T11:00:00.000Z",
      now: T0,
      validatedAt: T0,
      summaryText: MASTER_SUMMARY,
      operations: ops,
    };
    const missing = validateCorrectionSegments({ segments: derived, ...base });
    expect(missing.segments.find((segment) => segment.segmentId === `op:${OP}`)?.structural).toEqual({
      ok: false,
      reason: "PRIORITY_LINK_MISSING",
    });
    const foreignDerived = derived.map((segment) =>
      segment.segmentId === `op:${OP}` ? { ...segment, priorityIds: [H("9")] } : segment,
    );
    const foreign = validateCorrectionSegments({ segments: foreignDerived, ...base });
    expect(foreign.segments.find((segment) => segment.segmentId === `op:${OP}`)?.structural).toEqual({
      ok: false,
      reason: "FOREIGN_PRIORITY",
    });
  });

  it("untouched AI text keeps the employer guard; user edits are exempt", () => {
    const plan = parsedPlan();
    plan.suggestions[0] = {
      ...plan.suggestions[0],
      text: "Led discovery at Beacon Tools with Harbor buyers.",
    } as (typeof plan.suggestions)[number];
    const ops = [
      { op: "add", operationId: OP, suggestionId: "sug-001", roleId: "emp-harbor", editedText: null },
    ] as Parameters<typeof validateCorrectionSegments>[0]["operations"];
    const derived = deriveCorrectionSegments({
      plan,
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      summaryText: MASTER_SUMMARY,
      summaryOrigin: "master",
      operations: ops,
    });
    const draftHash = correctionDraftHashFor(
      Step2DraftV2.parse({
        schemaVersion: "step2-draft/v2",
        planId: PLAN_ID,
        planHash: H("1"),
        summaryText: MASTER_SUMMARY,
        summaryOrigin: "master",
        operations: ops,
      }),
    );
    const base = {
      plan,
      planHash: H("1"),
      draftHash,
      boundProfileVersionId: PROFILE_VERSION_ID,
      snapshotFacts: snapshotFacts(),
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      employments: EMPLOYMENTS,
      versionCreatedAt: "2026-09-18T10:00:00.000Z",
      planAcceptedAt: "2026-09-18T11:00:00.000Z",
      now: T0,
      validatedAt: T0,
      summaryText: MASTER_SUMMARY,
      operations: ops,
    };
    const untouched = validateCorrectionSegments({ segments: derived, ...base });
    expect(untouched.segments.find((segment) => segment.segmentId === `op:${OP}`)?.structural).toEqual({
      ok: false,
      reason: "FOREIGN_EMPLOYER",
    });
    const userEdited = derived.map((segment) =>
      segment.segmentId === `op:${OP}`
        ? { ...segment, text: `${segment.text} I also ran Beacon onboarding.`, userEdited: true }
        : segment,
    );
    const edited = validateCorrectionSegments({ segments: userEdited, ...base });
    const verdict = edited.segments.find((segment) => segment.segmentId === `op:${OP}`);
    expect(verdict?.structural).toEqual({ ok: true, reason: null });
    expect(verdict?.provenance).toBe("USER_EDITED");
  });

  it("coverage requires same-hash verdicts and fails closed on drift", () => {
    const ops = [
      { op: "add", operationId: OP, suggestionId: "sug-001", roleId: "emp-harbor", editedText: null },
    ] as Parameters<typeof validateCorrectionSegments>[0]["operations"];
    const validation = structuralFor(ops);
    const plan = parsedPlan();
    const fresh = deriveCorrectionSegments({
      plan,
      master: masterBullets(),
      masterSummary: MASTER_SUMMARY,
      summaryText: MASTER_SUMMARY,
      summaryOrigin: "master",
      operations: ops,
    });
    expect(verifyCorrectionCoverage({ derived: fresh, validation })).toMatchObject({
      covered: true,
      allStructuralOk: true,
      missing: [],
    });
    const drifted = fresh.map((segment) =>
      segment.segmentId === "summary" ? { ...segment, text: `${segment.text} Drift.` } : segment,
    );
    const skewed = verifyCorrectionCoverage({ derived: drifted, validation });
    expect(skewed.covered).toBe(false);
    expect(skewed.allStructuralOk).toBe(false);
    expect(skewed.missing).toEqual(["summary"]);
  });
});
