// @vitest-environment node
import { describe, expect, it } from "vitest";
import { newId } from "../../../src/db";
import { readPlan, readPreparationByJob } from "../../../src/db/step2";
import { canonicalText } from "../../../src/domain/canonical";
import { STEP2_REASONS } from "../../../src/domain/step2Claims";
import type { PreparationProposalV1Type } from "../../../src/tailoring/contract";
import { sha256HexUtf8 } from "../../../src/tailoring/hash";
import {
  buildAcceptedPlan,
  type BuildAcceptedPlanInput,
  type ProposalFact,
} from "../../../src/tailoring/preparePlan";
import { masterProjectionHashFor } from "../../../src/tailoring/step2policy";
import { TestPrepareProvider } from "../../../src/tailoring/testProvider";
import {
  claimS2b,
  finishS2bAttempt,
  pmEvidenceFor,
  proposalForS2b,
  proposalForS2bV2,
  runS2bAttempt,
  s2bSnapshotIds,
  scheduleS2b,
  seedS2bJob,
  withS2bDatabase,
} from "./s2b-world";

/**
 * WO-1.3-S2-B / S2B4: quote/fact/employer/number policy. Exact
 * UTF-8 spans validate; fabricated spans, foreign/unapproved
 * facts, swapped employers, and novel metrics can never publish
 * a usable suggestion; required gaps stay visible. Pure-policy
 * proofs plus one end-to-end run through the real handler.
 */

const S2B4_JD =
  "À propos — Senior Product Manager, Business Systems.\n" +
  "Own roadmap planning, stakeholder management, and NetSuite administration for finance.";

function planInputFor(
  t: Parameters<Parameters<typeof withS2bDatabase>[0]>[0],
  world: Parameters<Parameters<typeof withS2bDatabase>[0]>[1],
  jdText: string,
  proposal: PreparationProposalV1Type,
  facts: ProposalFact[],
): BuildAcceptedPlanInput {
  const basics = seedS2bJob(t.handle, world, jdText);
  scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
  const row = readPreparationByJob(t.handle, basics.jobId);
  if (row === null) {
    throw new Error("S2-B schedule left no row");
  }
  const evidence = pmEvidenceFor(t.handle, world);
  return {
    planId: newId(),
    preparationId: row.id,
    extractionId: basics.extractionId,
    jdHash: sha256HexUtf8(canonicalText(jdText)),
    canonicalJdText: canonicalText(jdText),
    profileVersionId: world.pmVersionId,
    evidenceHash: row.evidenceHash,
    masterProjectionHash: masterProjectionHashFor(evidence.payload),
    payload: evidence.payload,
    facts,
    proposal,
  };
}

function worldFacts(
  t: Parameters<Parameters<typeof withS2bDatabase>[0]>[0],
  world: Parameters<Parameters<typeof withS2bDatabase>[0]>[1],
  mutate: (facts: ProposalFact[]) => ProposalFact[] = (facts) => facts,
): ProposalFact[] {
  const evidence = pmEvidenceFor(t.handle, world);
  return mutate(
    evidence.payload.achievements.map((achievement) => ({
      factId: achievement.factId,
      statement: achievement.text,
      verification: achievement.verification,
      profileVersionId: world.pmVersionId,
      employmentId: achievement.employmentId ?? null,
      metrics: [...achievement.metrics],
    })),
  );
}

describe("S2B4 quote verification", () => {
  it("accepts exact UTF-8 byte spans after a multi-byte prefix", async () => {
    await withS2bDatabase(async (t, world) => {
      const canonicalJd = canonicalText(S2B4_JD);
      const prefix = "À propos — Senior Product Manager, Business Systems.\nOwn ";
      // The prefix is longer in bytes than in UTF-16 units: a span
      // placed after it proves byte (not char) indexing.
      expect(Buffer.byteLength(prefix, "utf8")).toBeGreaterThan(prefix.length);
      const proposal = proposalForS2b({
        jdText: canonicalJd,
        jdSnapshotId: "jd-snap",
        candidateSnapshotId: "cand-snap",
        quotes: [
          {
            text: "roadmap planning",
            importance: "required",
            matchStatus: "matched",
            factIds: ["pm-fact-roadmap"],
          },
          {
            text: "NetSuite administration",
            importance: "required",
            matchStatus: "gap",
            factIds: [],
          },
        ],
      });
      expect(proposal.priorities[0].quote.startByte).toBe(Buffer.byteLength(prefix, "utf8"));
      const built = buildAcceptedPlan(
        planInputFor(t, world, S2B4_JD, proposal, worldFacts(t, world)),
      );
      expect(built.ok).toBe(true);
      if (!built.ok) {
        throw new Error("S2-B plan build failed");
      }
      expect(built.plan.priorities).toHaveLength(2);
      expect(built.validation.droppedPriorities).toEqual([]);
    });
  });

  it("drops fabricated spans with reasons and rejects fully unverifiable proposals", async () => {
    await withS2bDatabase(async (t, world) => {
      const canonicalJd = canonicalText(S2B4_JD);
      const good = proposalForS2b({
        jdText: canonicalJd,
        jdSnapshotId: "jd-snap",
        candidateSnapshotId: "cand-snap",
        quotes: [
          {
            text: "roadmap planning",
            importance: "required",
            matchStatus: "matched",
            factIds: ["pm-fact-roadmap"],
          },
          {
            text: "stakeholder management",
            importance: "preferred",
            matchStatus: "matched",
            factIds: ["pm-fact-discovery"],
          },
          {
            text: "NetSuite administration",
            importance: "required",
            matchStatus: "gap",
            factIds: [],
          },
        ],
      });
      // Shifted offsets (bytes mismatch) and an inverted range.
      const mixed: PreparationProposalV1Type = {
        ...good,
        priorities: [
          good.priorities[0],
          {
            ...good.priorities[1],
            quote: {
              text: good.priorities[1].quote.text,
              startByte: good.priorities[1].quote.startByte + 2,
              endByte: good.priorities[1].quote.endByte + 2,
            },
          },
          {
            ...good.priorities[2],
            quote: {
              text: good.priorities[2].quote.text,
              startByte: good.priorities[2].quote.startByte,
              endByte: good.priorities[2].quote.startByte,
            },
          },
        ],
      };
      const partial = buildAcceptedPlan(planInputFor(t, world, S2B4_JD, mixed, worldFacts(t, world)));
      expect(partial.ok).toBe(true);
      if (!partial.ok) {
        throw new Error("S2-B plan build failed");
      }
      expect(partial.plan.priorities).toHaveLength(1);
      expect(partial.validation.droppedPriorities).toEqual([
        { index: 1, quote: "stakeholder management", reason: "QUOTE_BYTES_MISMATCH" },
        { index: 2, quote: "NetSuite administration", reason: "QUOTE_RANGE_INVALID" },
      ]);
      // Nothing verifiable: the proposal rejects outright.
      const fabricated: PreparationProposalV1Type = {
        ...good,
        priorities: mixed.priorities.slice(1),
      };
      const rejected = buildAcceptedPlan(
        planInputFor(t, world, S2B4_JD, fabricated, worldFacts(t, world)),
      );
      expect(rejected).toMatchObject({ ok: false, error: "ALL_QUOTES_INVALID" });
      const empty: PreparationProposalV1Type = { ...good, priorities: [] };
      const starved = buildAcceptedPlan(planInputFor(t, world, S2B4_JD, empty, worldFacts(t, world)));
      expect(starved).toMatchObject({ ok: false, error: "EMPTY_PRIORITIES" });
    });
  });
});

describe("S2B4 evidence policy", () => {
  it("drops foreign, unapproved, and unknown facts while required gaps stay visible", async () => {
    await withS2bDatabase(async (t, world) => {
      const canonicalJd = canonicalText(S2B4_JD);
      const proposal = proposalForS2b({
        jdText: canonicalJd,
        jdSnapshotId: "jd-snap",
        candidateSnapshotId: "cand-snap",
        quotes: [
          {
            text: "roadmap planning",
            importance: "required",
            matchStatus: "matched",
            factIds: [
              "pm-fact-roadmap",
              "pm-fact-pending",
              "spm-fact-strategy",
              "fact-no-such",
            ],
          },
          {
            text: "NetSuite administration",
            importance: "required",
            matchStatus: "gap",
            factIds: [],
          },
        ],
      });
      const facts = worldFacts(t, world, (all) => [
        ...all,
        {
          factId: "pm-fact-pending",
          statement: "Draft roadmap note.",
          verification: "PENDING",
          profileVersionId: world.pmVersionId,
          employmentId: "emp-harbor",
          metrics: [],
        },
        {
          factId: "spm-fact-strategy",
          statement: "Senior strategy work.",
          verification: "APPROVED",
          profileVersionId: world.spmVersionId,
          employmentId: null,
          metrics: [],
        },
      ]);
      const built = buildAcceptedPlan(planInputFor(t, world, S2B4_JD, proposal, facts));
      expect(built.ok).toBe(true);
      if (!built.ok) {
        throw new Error("S2-B plan build failed");
      }
      // Only the approved owned fact survives, with per-fact reasons.
      expect(built.plan.priorities[0].factIds).toEqual(["pm-fact-roadmap"]);
      expect(built.plan.priorities[0].support).toBe("supported");
      // The required NetSuite gap stays visible with empty evidence.
      expect(built.plan.priorities[1]).toMatchObject({ support: "gap", factIds: [] });
      expect(built.plan.featuredPriorityIds).toHaveLength(2);
    });
  });

  it("unusable suggestions are recorded, never published usable", async () => {
    await withS2bDatabase(async (t, world) => {
      const canonicalJd = canonicalText(S2B4_JD);
      const evidence = pmEvidenceFor(t.handle, world);
      const discovery = evidence.payload.achievements.find(
        (achievement) => achievement.factId === "pm-fact-discovery",
      );
      if (discovery === undefined) {
        throw new Error("S2-B world lost the discovery fact");
      }
      const proposal = proposalForS2b({
        jdText: canonicalJd,
        jdSnapshotId: "jd-snap",
        candidateSnapshotId: "cand-snap",
        quotes: [
          {
            text: "roadmap planning",
            importance: "required",
            matchStatus: "matched",
            factIds: ["pm-fact-roadmap"],
          },
        ],
        suggestions: [
          {
            roleId: "emp-harbor",
            text: canonicalText(discovery.text),
            factIds: ["pm-fact-discovery"],
          },
          {
            roleId: "emp-harbor",
            text: "Led discovery at Beacon Tools with buyers.",
            factIds: ["pm-fact-discovery"],
          },
          {
            roleId: "emp-harbor",
            text: "Led customer discovery with 40+ buyers and lifted retention by 98%.",
            factIds: ["pm-fact-discovery"],
          },
          { roleId: "emp-ghost", text: "Did roadmap work.", factIds: ["pm-fact-roadmap"] },
          { roleId: "emp-harbor", text: "Did roadmap work.", factIds: ["fact-no-such"] },
          {
            roleId: "emp-harbor",
            text: "Ran experiments with squads.",
            factIds: ["pm-fact-experiment"],
          },
        ],
      });
      const built = buildAcceptedPlan(planInputFor(t, world, S2B4_JD, proposal, worldFacts(t, world)));
      expect(built.ok).toBe(true);
      if (!built.ok) {
        throw new Error("S2-B plan build failed");
      }
      const verdicts = built.plan.suggestions.map((suggestion) => [
        suggestion.suggestionId,
        suggestion.usable,
        suggestion.unusableReason,
      ]);
      expect(verdicts).toEqual([
        ["sug-001", true, null],
        ["sug-002", false, "EMPLOYER_SWAP"],
        ["sug-003", false, "NEW_METRIC"],
        ["sug-004", false, "UNKNOWN_ROLE"],
        ["sug-005", false, "NO_EVIDENCE"],
        ["sug-006", false, "NO_EVIDENCE"],
      ]);
      // The Beacon-owned fact cited under Harbor drops as foreign-role.
      const records = built.validation.suggestions;
      expect(records[5].droppedFactIds).toEqual([
        { factId: "pm-fact-experiment", reason: STEP2_REASONS.FOREIGN_ROLE_FACT },
      ]);
      expect(records[4].droppedFactIds).toEqual([
        { factId: "fact-no-such", reason: STEP2_REASONS.UNKNOWN_FACT },
      ]);
      // No usable suggestion lacks evidence — an invariant over the plan.
      for (const suggestion of built.plan.suggestions) {
        if (suggestion.usable) {
          expect(suggestion.factIds.length).toBeGreaterThan(0);
          expect(suggestion.unusableReason).toBeNull();
        }
      }
    });
  });

  it("angles without evidence or duplicating the master summary drop", async () => {
    await withS2bDatabase(async (t, world) => {
      const canonicalJd = canonicalText(S2B4_JD);
      const evidence = pmEvidenceFor(t.handle, world);
      const proposal = proposalForS2b({
        jdText: canonicalJd,
        jdSnapshotId: "jd-snap",
        candidateSnapshotId: "cand-snap",
        quotes: [
          {
            text: "roadmap planning",
            importance: "required",
            matchStatus: "matched",
            factIds: ["pm-fact-roadmap"],
          },
        ],
        angles: [
          {
            title: "Ghost angle",
            summaryText: "Work no fact supports.",
            factIds: ["fact-no-such"],
          },
          {
            title: "Master echo",
            summaryText: canonicalText(evidence.payload.summary ?? ""),
            factIds: ["pm-fact-discovery"],
          },
          {
            title: "Discovery-led roadmap",
            summaryText: "Discovery interviews that reshape roadmaps and lift conversion.",
            factIds: ["pm-fact-discovery", "pm-fact-roadmap"],
          },
        ],
      });
      const built = buildAcceptedPlan(planInputFor(t, world, S2B4_JD, proposal, worldFacts(t, world)));
      expect(built.ok).toBe(true);
      if (!built.ok) {
        throw new Error("S2-B plan build failed");
      }
      expect(built.plan.positioning.angles.map((angle) => angle.title)).toEqual([
        "Discovery-led roadmap",
      ]);
      expect(built.validation.droppedAngles).toEqual([
        { index: 0, title: "Ghost angle", reason: "NO_EVIDENCE" },
        { index: 1, title: "Master echo", reason: "DUPLICATE_ANGLE" },
      ]);
    });
  });
});

describe("S2B4 end-to-end policy enforcement", () => {
  it("a Unicode JD with a NetSuite gap publishes a policy-clean plan", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world, S2B4_JD);
      const kitSnapshots = s2bSnapshotIds(t.handle, basics, S2B4_JD);
      const evidence = pmEvidenceFor(t.handle, world);
      const discovery = evidence.payload.achievements.find(
        (achievement) => achievement.factId === "pm-fact-discovery",
      );
      if (discovery === undefined) {
        throw new Error("S2-B world lost the discovery fact");
      }
      const proposal = proposalForS2bV2({
        jdText: canonicalText(S2B4_JD),
        jdSnapshotId: kitSnapshots.jdSnapshotId,
        candidateSnapshotId: kitSnapshots.candidateSnapshotId,
        extractionId: basics.extractionId,
        jdHash: sha256HexUtf8(canonicalText(S2B4_JD)),
        quotes: [
          {
            text: "NetSuite administration",
            importance: "required",
            matchStatus: "gap",
            factIds: [],
          },
          {
            text: "roadmap planning",
            importance: "required",
            matchStatus: "matched",
            factIds: ["pm-fact-roadmap"],
          },
        ],
        suggestions: [
          {
            roleId: "emp-harbor",
            text: canonicalText(discovery.text),
            factIds: ["pm-fact-discovery"],
          },
          {
            roleId: "emp-harbor",
            text: "Administered NetSuite across 6 subsidiaries.",
            factIds: ["pm-fact-discovery"],
          },
        ],
      });
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const provider = new TestPrepareProvider({
        proposals: { [kitSnapshots.jdSnapshotId]: proposal },
      });
      const claimed = claimS2b(t.handle);
      const outcome = await runS2bAttempt(t.handle, claimed, provider);
      expect(outcome.result).toBe("SUCCEEDED");
      finishS2bAttempt(t.handle, { ...claimed, outcome });

      const row = readPreparationByJob(t.handle, basics.jobId);
      const stored = readPlan(t.handle, row?.acceptedPlanId as string);
      const plan = JSON.parse(stored?.planJson as string) as {
        priorities: Array<{ support: string; factIds: string[]; quote: { text: string } }>;
        suggestions: Array<{ usable: boolean; unusableReason: string | null }>;
      };
      // NetSuite stays a visible required gap; the supported priority holds.
      expect(plan.priorities).toHaveLength(2);
      expect(plan.priorities[0]).toMatchObject({ support: "gap", factIds: [] });
      expect(plan.priorities[0].quote.text).toBe("NetSuite administration");
      expect(plan.priorities[1].support).toBe("supported");
      // The verbatim suggestion is usable; the NetSuite claim with
      // its unsupported "6 subsidiaries" metric is recorded unusable.
      expect(plan.suggestions[0]).toMatchObject({ usable: true, unusableReason: null });
      expect(plan.suggestions[1]).toMatchObject({ usable: false, unusableReason: "NEW_METRIC" });
      expect(stored?.claimsPolicyVersion).toBe("step2-claims/2");
      expect(stored?.promptVersion).not.toBeNull();
      expect(stored?.planHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
