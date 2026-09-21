import { canonicalText } from "../domain/canonical";
import type { StoredProfilePayload } from "../domain/candidate";
import {
  STEP2_BUDGETS,
  STEP2_PLAN_VALIDATION_VERSION,
  type PlanSuggestionV1 as PlanSuggestionV1Type,
  type PreparationPlanV1 as PreparationPlanV1Type,
  type PreparationProposalV1 as PreparationProposalV1Type,
} from "../domain/step2";
import {
  claimKey,
  namedCompanies,
  novelNumbers,
  recomputePrioritySupport,
  STEP2_REASONS,
  type Step2SnapshotFact,
} from "../domain/step2Claims";
import { phraseIdFor } from "./requestsV3";

/**
 * Proposal → accepted-plan builder (WO-1.3-S2-B, S2-A §7.2). Pure:
 * per-item deterministic checks over the provider proposal, the
 * canonical JD bytes, the captured payload, and the bound approved
 * facts. Quotes must select exact UTF-8 ranges; citations must be
 * approved and owned (role-owned for the suggestion's role,
 * transferable anywhere); suggestions with novel numbers or
 * swapped employers are recorded unusable, never published usable.
 * Whole-proposal rejection (empty or fully unverifiable priorities)
 * returns `rejected` so the handler fails INVALID_RESPONSE.
 */

export interface ProposalFact {
  factId: string;
  statement: string;
  verification: string;
  profileVersionId: string;
  employmentId: string | null;
  metrics: string[];
}

export interface BuildAcceptedPlanInput {
  planId: string;
  preparationId: string;
  extractionId: string;
  jdHash: string;
  canonicalJdText: string;
  profileVersionId: string;
  evidenceHash: string;
  masterProjectionHash: string;
  payload: StoredProfilePayload;
  facts: ProposalFact[];
  proposal: PreparationProposalV1Type;
}

export type BuildAcceptedPlanResult =
  | {
      ok: true;
      plan: PreparationPlanV1Type;
      validation: {
        schemaVersion: typeof STEP2_PLAN_VALIDATION_VERSION;
        droppedPriorities: Array<{ index: number; quote: string; reason: string }>;
        droppedAngles: Array<{ index: number; title: string; reason: string }>;
        suggestions: Array<{
          suggestionId: string;
          usable: boolean;
          unusableReason: string | null;
          keptFactIds: string[];
          droppedFactIds: Array<{ factId: string; reason: string }>;
        }>;
      };
    }
  | { ok: false; error: "EMPTY_PRIORITIES" | "ALL_QUOTES_INVALID"; detail: string };

function verifyQuote(
  jdBytes: Buffer,
  quote: { text: string; startByte: number; endByte: number },
): string | null {
  const { startByte, endByte, text } = quote;
  if (
    !Number.isInteger(startByte) ||
    !Number.isInteger(endByte) ||
    endByte <= startByte ||
    endByte > jdBytes.length
  ) {
    return "QUOTE_RANGE_INVALID";
  }
  const slice = jdBytes.subarray(startByte, endByte);
  const decoded = slice.toString("utf8");
  if (decoded !== text || Buffer.from(decoded, "utf8").equals(slice) === false) {
    return "QUOTE_BYTES_MISMATCH";
  }
  return null;
}

function snapshotFacts(facts: ProposalFact[]): Step2SnapshotFact[] {
  return facts.map((fact) => ({
    factId: fact.factId,
    statement: fact.statement,
    verification: fact.verification,
    profileVersionId: fact.profileVersionId,
    employmentId: fact.employmentId,
    metrics: [...fact.metrics],
  }));
}

const IMPORTANCE_RANK: Record<string, number> = {
  required: 0,
  preferred: 1,
  unspecified: 2,
};

export function buildAcceptedPlan(input: BuildAcceptedPlanInput): BuildAcceptedPlanResult {
  const jdBytes = Buffer.from(input.canonicalJdText, "utf8");
  const factsById = new Map(snapshotFacts(input.facts).map((fact) => [fact.factId, fact]));
  const employments = input.payload.employment.map((entry) => ({
    id: entry.id,
    company: entry.company,
  }));
  const employmentIds = new Set(employments.map((entry) => entry.id));

  if (input.proposal.priorities.length === 0 && input.canonicalJdText !== "") {
    return {
      ok: false,
      error: "EMPTY_PRIORITIES",
      detail: "provider returned no priorities for a non-empty job description",
    };
  }

  const droppedPriorities: Array<{ index: number; quote: string; reason: string }> = [];
  const priorities: PreparationPlanV1Type["priorities"] = [];
  input.proposal.priorities.forEach((priority, index) => {
    const quoteFailure = verifyQuote(jdBytes, priority.quote);
    if (quoteFailure !== null) {
      droppedPriorities.push({ index, quote: priority.quote.text.slice(0, 512), reason: quoteFailure });
      return;
    }
    const support = recomputePrioritySupport(priority.factIds, factsById, input.profileVersionId);
    priorities.push({
      priorityId: phraseIdFor({
        extractionId: input.extractionId,
        jdHash: input.jdHash,
        startByte: priority.quote.startByte,
        endByte: priority.quote.endByte,
        text: priority.quote.text,
      }),
      quote: { ...priority.quote },
      count: priority.count,
      category: priority.category,
      importance: priority.importance,
      support: support.support,
      factIds: support.keptFactIds,
    });
  });

  if (priorities.length === 0) {
    return {
      ok: false,
      error: "ALL_QUOTES_INVALID",
      detail: "every proposed priority failed quote verification",
    };
  }

  const featuredPriorityIds = [...priorities]
    .sort((left, right) => {
      const rank = (IMPORTANCE_RANK[left.importance] ?? 2) - (IMPORTANCE_RANK[right.importance] ?? 2);
      if (rank !== 0) {
        return rank;
      }
      return priorities.indexOf(left) - priorities.indexOf(right);
    })
    .slice(0, STEP2_BUDGETS.featuredPriorities)
    .map((priority) => priority.priorityId);

  const keepMasterSummary = canonicalText(input.payload.summary ?? "");
  const droppedAngles: Array<{ index: number; title: string; reason: string }> = [];
  const angles: PreparationPlanV1Type["positioning"]["angles"] = [];
  const seenAngleKeys = new Set<string>(keepMasterSummary === "" ? [] : [claimKey(keepMasterSummary)]);
  input.proposal.angles.forEach((angle, index) => {
    const kept = angle.factIds.filter((factId) => {
      const fact = factsById.get(factId);
      return (
        fact !== undefined &&
        fact.verification === "APPROVED" &&
        fact.profileVersionId === input.profileVersionId
      );
    });
    if (kept.length === 0) {
      droppedAngles.push({ index, title: angle.title, reason: "NO_EVIDENCE" });
      return;
    }
    const key = claimKey(angle.summaryText);
    if (seenAngleKeys.has(key)) {
      droppedAngles.push({ index, title: angle.title, reason: "DUPLICATE_ANGLE" });
      return;
    }
    seenAngleKeys.add(key);
    angles.push({ angleId: `angle-${angles.length + 1}`, title: angle.title, summaryText: angle.summaryText, factIds: kept });
  });

  const suggestions: PlanSuggestionV1Type[] = [];
  const suggestionRecords: Array<{
    suggestionId: string;
    usable: boolean;
    unusableReason: string | null;
    keptFactIds: string[];
    droppedFactIds: Array<{ factId: string; reason: string }>;
  }> = [];
  input.proposal.suggestions.forEach((suggestion, index) => {
    const suggestionId = `sug-${String(index + 1).padStart(3, "0")}`;
    const droppedFactIds: Array<{ factId: string; reason: string }> = [];
    const keptFactIds: string[] = [];
    const roleKnown = employmentIds.has(suggestion.roleId);
    if (roleKnown) {
      for (const factId of suggestion.factIds) {
        const fact = factsById.get(factId);
        if (fact === undefined) {
          droppedFactIds.push({ factId, reason: STEP2_REASONS.UNKNOWN_FACT });
        } else if (fact.verification !== "APPROVED") {
          droppedFactIds.push({ factId, reason: STEP2_REASONS.FACT_NOT_APPROVED });
        } else if (fact.profileVersionId !== input.profileVersionId) {
          droppedFactIds.push({ factId, reason: STEP2_REASONS.FOREIGN_FACT });
        } else if (fact.employmentId !== null && fact.employmentId !== suggestion.roleId) {
          droppedFactIds.push({ factId, reason: STEP2_REASONS.FOREIGN_ROLE_FACT });
        } else {
          keptFactIds.push(factId);
        }
      }
    }
    let usable = true;
    let unusableReason: string | null = null;
    if (!roleKnown) {
      usable = false;
      unusableReason = "UNKNOWN_ROLE";
    } else if (keptFactIds.length === 0) {
      usable = false;
      unusableReason = "NO_EVIDENCE";
    } else {
      const citedTexts: string[] = [];
      for (const factId of keptFactIds) {
        const fact = factsById.get(factId);
        if (fact !== undefined) {
          citedTexts.push(fact.statement, ...(fact.metrics ?? []));
        }
      }
      if (novelNumbers(suggestion.text, citedTexts).length > 0) {
        usable = false;
        unusableReason = "NEW_METRIC";
      } else {
        const roleEmployer = employments.find((entry) => entry.id === suggestion.roleId)?.company ?? null;
        const foreign = namedCompanies(suggestion.text, employments).filter(
          (name) => name !== roleEmployer,
        );
        if (foreign.length > 0) {
          usable = false;
          unusableReason = "EMPLOYER_SWAP";
        }
      }
    }
    suggestions.push({
      suggestionId,
      roleId: suggestion.roleId,
      text: suggestion.text,
      factIds: keptFactIds.length > 0 ? keptFactIds : suggestion.factIds.slice(0, 20),
      usable,
      unusableReason,
    });
    suggestionRecords.push({ suggestionId, usable, unusableReason, keptFactIds, droppedFactIds });
  });

  return {
    ok: true,
    plan: {
      schemaVersion: "step2-plan/v1",
      planId: input.planId,
      preparationId: input.preparationId,
      extractionId: input.extractionId,
      jdHash: input.jdHash,
      profileVersionId: input.profileVersionId,
      evidenceHash: input.evidenceHash,
      masterProjectionHash: input.masterProjectionHash,
      priorities,
      featuredPriorityIds,
      positioning: { keepMasterSummary, angles },
      suggestions,
      rationale: input.proposal.rationale,
    },
    validation: {
      schemaVersion: STEP2_PLAN_VALIDATION_VERSION,
      droppedPriorities,
      droppedAngles,
      suggestions: suggestionRecords,
    },
  };
}
