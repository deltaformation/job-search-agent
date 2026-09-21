// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  STEP2_BUDGETS,
  Step2DraftV1,
  checkStep2Budgets,
  masterBulletsByRole,
  projectBulletCounts,
  type PreparationPlanV1 as PreparationPlanV1Type,
  type Step2DraftOperationV1,
} from "../../../src/domain/step2";
import {
  claimKey,
  namedCompanies,
  novelNumbers,
  recomputePrioritySupport,
} from "../../../src/domain/step2Claims";
import {
  draftHashFor,
  draftHashMatches,
  validateStep2Segments,
  verifyPlanQuotes,
} from "../../../src/tailoring/step2policy";
import {
  loadPmExpected,
  loadPmJd,
  loadPmProfile,
  loadSparseExpected,
  loadSparseJd,
  loadSparseProfile,
  planTextsFor,
  pmPlan,
  snapshotFactsFor,
  sparsePlan,
} from "./s2a-world";

/**
 * WO-1.3-S2-A / S2A3: fixed evaluation fixtures pin the
 * `step2-claims/1` algorithm — UTF-8 spans, the required NetSuite
 * gap, distinct angles, sparse no-padding, contamination, and every
 * prohibited edited claim with its expected verdict.
 */

const PM = loadPmExpected();
const PM_JD = loadPmJd();
const PM_PROFILE = loadPmProfile();
const PM_PLAN = pmPlan(PM);
const PM_FACTS = snapshotFactsFor(PM_PROFILE, PM.profileVersionId);
const PM_FACTS_BY_ID = new Map(PM_FACTS.map((f) => [f.factId, f]));
const PM_EMPLOYMENTS = PM_PROFILE.employment.map((e) => ({
  id: e.id,
  company: e.company,
}));

function validatePm(overrides: Record<string, unknown> = {}) {
  return validateStep2Segments({
    segments: PM.segments.map((s) => ({
      segmentId: s.segmentId,
      kind: s.kind,
      roleId: s.roleId,
      text: s.text,
      citedFactIds: [...s.citedFactIds],
      ...(s.derivation === undefined ? {} : { derivation: s.derivation }),
    })),
    planId: PM.planId,
    planHash: PM.planHash,
    draftHash:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    boundProfileVersionId: PM.profileVersionId,
    snapshotFacts: PM_FACTS,
    planTexts: planTextsFor(PM_PLAN),
    master: masterBulletsByRole(PM_PROFILE),
    employments: PM_EMPLOYMENTS,
    versionCreatedAt: PM.versionCreatedAt,
    planAcceptedAt: PM.planAcceptedAt,
    now: PM.now,
    validatedAt: PM.now,
    summaryText: PM_PLAN.positioning.keepMasterSummary,
    operations: [],
    ...overrides,
  });
}

describe("S2A3 quote verification over fixed spans", () => {
  it("every recorded PM quote selects its exact UTF-8 bytes", () => {
    const checks = verifyPlanQuotes(PM_PLAN, PM_JD);
    expect(checks).toHaveLength(6);
    for (const check of checks) {
      expect(check).toEqual({
        priorityId: check.priorityId,
        ok: true,
        reason: null,
      });
    }
  });

  it("the fixture discriminates UTF-8 bytes from UTF-16 indices", () => {
    // Non-ASCII opener shifts every post-prefix span: byte offsets and
    // JS string indices disagree, so a UTF-16 implementation fails.
    for (const priority of PM.priorities) {
      const jsIndex = PM_JD.indexOf(priority.quote.text);
      expect(jsIndex).toBeGreaterThanOrEqual(0);
      expect(priority.quote.startByte).not.toBe(jsIndex);
    }
    const trapped: PreparationPlanV1Type = {
      ...PM_PLAN,
      priorities: PM_PLAN.priorities.map((priority) => {
        const jsIndex = PM_JD.indexOf(priority.quote.text);
        return {
          ...priority,
          quote: {
            ...priority.quote,
            startByte: jsIndex,
            endByte: jsIndex + priority.quote.text.length,
          },
        };
      }),
    };
    const checks = verifyPlanQuotes(trapped, PM_JD);
    expect(checks.some((check) => check.ok === false)).toBe(true);
  });

  it("tampered ranges and text fail with stable reasons", () => {
    const shifted: PreparationPlanV1Type = {
      ...PM_PLAN,
      priorities: [
        {
          ...PM_PLAN.priorities[0],
          quote: { ...PM_PLAN.priorities[0].quote, startByte: 0, endByte: 1 },
        },
      ],
    };
    expect(verifyPlanQuotes(shifted, PM_JD)[0]).toEqual({
      priorityId: shifted.priorities[0].priorityId,
      ok: false,
      reason: "QUOTE_BYTES_MISMATCH",
    });
    const invalid: PreparationPlanV1Type = {
      ...PM_PLAN,
      priorities: [
        {
          ...PM_PLAN.priorities[0],
          quote: { ...PM_PLAN.priorities[0].quote, endByte: 1_000_000 },
        },
      ],
    };
    expect(verifyPlanQuotes(invalid, PM_JD)[0]?.reason).toBe(
      "QUOTE_RANGE_INVALID",
    );
  });

  it("NetSuite is required, a gap, and cites zero kept facts", () => {
    const netsuite = PM.priorities.find((p) => p.key === "netsuite");
    expect(netsuite?.importance).toBe("required");
    expect(netsuite?.support).toBe("gap");
    const recomputed = recomputePrioritySupport(
      netsuite?.factIds ?? ["unexpected"],
      PM_FACTS_BY_ID,
      PM.profileVersionId,
    );
    expect(recomputed).toEqual({
      support: "gap",
      keptFactIds: [],
      droppedFactIds: [],
    });
  });

  it("recomputed support matches every recorded badge", () => {
    for (const priority of PM.priorities) {
      const recomputed = recomputePrioritySupport(
        priority.factIds,
        PM_FACTS_BY_ID,
        PM.profileVersionId,
      );
      expect(recomputed.support).toBe(priority.support);
    }
    const roadmap = PM.priorities.find((p) => p.key === "roadmap");
    const dropped = recomputePrioritySupport(
      roadmap?.factIds ?? [],
      PM_FACTS_BY_ID,
      PM.profileVersionId,
    );
    expect(dropped.droppedFactIds).toEqual([
      { factId: "fact-pending-1", reason: "FACT_NOT_APPROVED" },
    ]);
  });

  it("angles are distinct from each other and keep-master", () => {
    const [first, second] = PM_PLAN.positioning.angles;
    expect(claimKey(first.summaryText)).not.toBe(claimKey(second.summaryText));
    expect(claimKey(first.summaryText)).not.toBe(
      claimKey(PM_PLAN.positioning.keepMasterSummary),
    );
  });
});

describe("S2A3 edited-text verdicts match recorded expectations", () => {
  const result = validatePm();
  for (const expected of PM.segments) {
    it(`${expected.case} -> ${expected.verdict}${expected.reason ? `/${expected.reason}` : ""}`, () => {
      const actual = result.segments.find(
        (segment) => segment.segmentId === expected.segmentId,
      );
      expect(actual?.verdict).toBe(expected.verdict);
      expect(actual?.match).toBe(expected.match);
      expect(actual?.reason).toBe(expected.reason);
      expect(actual?.textHash).toMatch(/^[0-9a-f]{64}$/);
      expect(actual?.normalizedHash).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it("no prohibited claim is supportable", () => {
    for (const name of PM.prohibitedClaimCases) {
      const expected = PM.segments.find((s) => s.case === name);
      const actual = result.segments.find(
        (s) => s.segmentId === expected?.segmentId,
      );
      expect(actual?.verdict).toBe("needs-evidence");
    }
  });

  it("entity helpers are necessary-condition filters only", () => {
    expect(novelNumbers("across 12 markets", ["across 4 markets"])).toEqual([
      "12",
    ]);
    expect(novelNumbers("across 4 markets", ["across 4 markets"])).toEqual([]);
    expect(namedCompanies("for Volt Mobility staff", PM_EMPLOYMENTS)).toEqual([
      "Volt Mobility",
    ]);
    expect(namedCompanies("for Quo staff", PM_EMPLOYMENTS)).toEqual([]);
  });

  it("chronology violations fail closed", () => {
    const late = validatePm({ planAcceptedAt: "2026-09-18T00:00:00.000Z" });
    expect(
      late.segments.every(
        (segment) =>
          segment.verdict === "needs-evidence" &&
          segment.reason === "CHRONOLOGY",
      ),
    ).toBe(true);
  });

  it("draft hash race comparison distinguishes edited bytes", () => {
    const op: Step2DraftOperationV1 = {
      op: "add",
      operationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      suggestionId: "sug-001",
      roleId: "emp-northwind",
      editedText: null,
    };
    const draft = {
      planId: PM.planId,
      planHash: PM.planHash,
      summaryText: "Summary.",
      summarySource: "master" as const,
      operations: [op],
    };
    const hash = draftHashFor(
      Step2DraftV1.parse({ schemaVersion: "step2-draft/v1", ...draft }),
    );
    expect(draftHashMatches(hash, draft)).toBe(true);
    expect(draftHashMatches(hash, { ...draft, summaryText: "Edited." })).toBe(
      false,
    );
  });
});

describe("S2A3 sparse case accepts without padding", () => {
  const sparse = loadSparseExpected();
  const plan = sparsePlan(sparse);
  const jd = loadSparseJd();

  it("sparse plan parses with two priorities and zero suggestions", () => {
    expect(plan.priorities).toHaveLength(2);
    expect(plan.suggestions).toHaveLength(0);
    expect(plan.positioning.angles).toHaveLength(0);
    expect(plan.featuredPriorityIds).toHaveLength(2);
  });

  it("sparse quotes verify and badges recompute", () => {
    const checks = verifyPlanQuotes(plan, jd);
    expect(checks.every((check) => check.ok)).toBe(true);
    const profile = loadSparseProfile();
    const facts = new Map(
      snapshotFactsFor(profile, sparse.profileVersionId).map((fact) => [
        fact.factId,
        fact,
      ]),
    );
    expect(
      recomputePrioritySupport(
        plan.priorities[0].factIds,
        facts,
        sparse.profileVersionId,
      ).support,
    ).toBe("supported");
    expect(
      recomputePrioritySupport(
        plan.priorities[1].factIds,
        facts,
        sparse.profileVersionId,
      ).support,
    ).toBe("gap");
  });
});

describe("S2A3 budgets project counts without silent drops", () => {
  const master = masterBulletsByRole(loadPmProfile());

  it("add/replace/exclude project exact per-role counts", () => {
    const add: Step2DraftOperationV1 = {
      op: "add",
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      suggestionId: "sug-001",
      roleId: "emp-northwind",
      editedText: null,
    };
    const projected = projectBulletCounts(master, [add]);
    const northwind = projected.perRole.find(
      (row) => row.roleId === "emp-northwind",
    );
    expect(northwind?.bullets).toBe(4);
    const report = checkStep2Budgets({
      summaryText: "Short.",
      master,
      operations: [add],
    });
    expect(report.exceeded).toBe(true);
    expect(report.totalBullets).toBe(master.length + 1);

    const exclude: Step2DraftOperationV1 = {
      op: "exclude",
      operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      targetFactId: "fact-nw-1",
    };
    const afterExclude = projectBulletCounts(master, [add, exclude]);
    expect(
      afterExclude.perRole.find((row) => row.roleId === "emp-northwind")
        ?.bullets,
    ).toBe(3);
    expect(afterExclude.total).toBe(master.length);
  });

  it("budget constants match architecture section budgets", () => {
    expect(STEP2_BUDGETS.summaryChars).toBe(4000);
    expect(STEP2_BUDGETS.bulletsPerRole).toBe(3);
    expect(STEP2_BUDGETS.totalBullets).toBe(14);
    expect(STEP2_BUDGETS.operations).toBe(50);
  });
});
