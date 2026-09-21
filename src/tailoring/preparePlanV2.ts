import { canonicalText } from "../domain/canonical";
import type { StoredProfilePayload } from "../domain/candidate";
import { STEP2_BUDGETS } from "../domain/step2";
import {
  STEP2_CORRECTION_VERSIONS,
  deriveEligibleRoles,
  type PlanSuggestionV2 as PlanSuggestionV2Type,
  type PlanValidationV2 as PlanValidationV2Type,
  type PreparationPlanV2 as PreparationPlanV2Type,
  type PreparationProposalV2 as PreparationProposalV2Type,
} from "../domain/step2Correction";
import {
  claimKey,
  namedCompanies,
  novelNumbers,
  recomputePrioritySupport,
  STEP2_REASONS,
  type Step2SnapshotFact,
} from "../domain/step2Claims";
import { phraseIdFor } from "./requestsV3";
import type { ProposalFact } from "./preparePlan";

/**
 * Proposal → accepted-plan builder v2 (WO-1.3-S2-CP-B, correction
 * contracts §7.2). Pure: per-item deterministic checks over the v2
 * provider proposal, the canonical JD bytes, the captured payload,
 * and the bound approved facts.
 *
 * Traceability is per-item (correction contracts §7.2): angles
 * that keep no approved anchor, keep no same-plan link, or
 * duplicate an accepted angle are dropped; suggestions that keep
 * no anchor or no link are dropped from the plan with a recorded
 * `usable: false` disposition (`INVALID_ANCHOR` /
 * `PRIORITY_LINK_MISSING`) — the v2 plan schema requires ≥1
 * anchor and ≥1 link per suggestion, so untraceable items cannot
 * be emitted. Content defects (novel numbers, employer swaps,
 * mixed ownership, unknown or ineligible provider roles) mark an
 * otherwise traceable suggestion `usable: false` with a recorded
 * reason while the plan still accepts — sparse valid plans are
 * never padded. Wholesale rejection (`UNTRACEABLE_PROPOSAL`, no
 * plan row, handler INVALID_RESPONSE) applies only when no kept
 * inbound link survives anywhere (zero LINKED priorities),
 * alongside the empty-priorities and all-quotes-invalid gates.
 *
 * The v1 builder (`preparePlan.ts`) is untouched: historical plans
 * keep their bytes, hashes, and readers.
 */

export interface BuildAcceptedPlanV2Input {
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
  proposal: PreparationProposalV2Type;
}

export type BuildAcceptedPlanV2Result =
  | { ok: true; plan: PreparationPlanV2Type; validation: PlanValidationV2Type }
  | {
      ok: false;
      error: "EMPTY_PRIORITIES" | "ALL_QUOTES_INVALID" | "UNTRACEABLE_PROPOSAL";
      detail: string;
    };

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

interface ResolvedLinks {
  kept: string[];
  dropped: Array<{ priorityId: string; reason: string }>;
}

function resolvePriorityLinks(
  links: string[],
  acceptedIds: ReadonlySet<string>,
): ResolvedLinks {
  const kept: string[] = [];
  const dropped: Array<{ priorityId: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (seen.has(link)) {
      dropped.push({ priorityId: link.slice(0, 128), reason: "DUPLICATE_PRIORITY_LINK" });
      continue;
    }
    seen.add(link);
    if (!acceptedIds.has(link)) {
      dropped.push({ priorityId: link.slice(0, 128), reason: "FOREIGN_PRIORITY" });
      continue;
    }
    kept.push(link);
  }
  return { kept, dropped };
}

export function buildAcceptedPlanV2(input: BuildAcceptedPlanV2Input): BuildAcceptedPlanV2Result {
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
  const priorities: PreparationPlanV2Type["priorities"] = [];
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
  const acceptedIds = new Set(priorities.map((priority) => priority.priorityId));

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
  const angles: PreparationPlanV2Type["positioning"]["angles"] = [];
  const angleRecords: PlanValidationV2Type["angles"] = [];
  const seenAngleKeys = new Set<string>(keepMasterSummary === "" ? [] : [claimKey(keepMasterSummary)]);
  for (const angle of input.proposal.angles) {
    const keptFactIds = angle.factIds.filter((factId) => {
      const fact = factsById.get(factId);
      return (
        fact !== undefined &&
        fact.verification === "APPROVED" &&
        fact.profileVersionId === input.profileVersionId
      );
    });
    if (keptFactIds.length === 0) {
      continue;
    }
    const links = resolvePriorityLinks(angle.priorityIds, acceptedIds);
    if (links.kept.length === 0) {
      continue;
    }
    const key = claimKey(angle.summaryText);
    if (seenAngleKeys.has(key)) {
      continue;
    }
    seenAngleKeys.add(key);
    const angleId = `angle-${angles.length + 1}`;
    angles.push({
      angleId,
      title: angle.title,
      summaryText: angle.summaryText,
      factIds: keptFactIds,
      priorityIds: links.kept,
    });
    angleRecords.push({
      angleId,
      keptPriorityIds: links.kept,
      droppedPriorityIds: links.dropped,
    });
  }

  const suggestions: PlanSuggestionV2Type[] = [];
  const suggestionRecords: PlanValidationV2Type["suggestions"] = [];
  for (const [index, suggestion] of input.proposal.suggestions.entries()) {
    const suggestionId = `sug-${String(index + 1).padStart(3, "0")}`;
    const roleKnown = employmentIds.has(suggestion.roleId);
    const droppedFactIds: Array<{ factId: string; reason: string }> = [];
    const keptFactIds: string[] = [];
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
    const links = resolvePriorityLinks(suggestion.priorityIds, acceptedIds);
    // Untraceable items leave the plan (the v2 plan schema
    // requires ≥1 anchor and ≥1 link per suggestion) but keep a
    // validation disposition, so the rest of the plan still
    // accepts per §7.2.
    const dropReason =
      keptFactIds.length === 0
        ? "INVALID_ANCHOR"
        : links.kept.length === 0
          ? "PRIORITY_LINK_MISSING"
          : null;
    if (dropReason !== null) {
      suggestionRecords.push({
        suggestionId,
        usable: false,
        unusableReason: dropReason,
        keptFactIds,
        droppedFactIds,
        keptPriorityIds: links.kept,
        droppedPriorityIds: links.dropped,
        eligibleRoleIds: [],
      });
      continue;
    }
    const employmentByFactId = new Map<string, string | null>();
    for (const factId of keptFactIds) {
      employmentByFactId.set(factId, factsById.get(factId)?.employmentId ?? null);
    }
    const derived = deriveEligibleRoles({
      citedFactIds: keptFactIds,
      employmentByFactId,
      employmentIds: employments.map((entry) => entry.id),
    });
    let usable = true;
    let unusableReason: string | null = null;
    if (!roleKnown) {
      usable = false;
      unusableReason = "UNKNOWN_ROLE";
    } else if (derived.ownership === "mixed" || derived.ownership === "unknown") {
      usable = false;
      unusableReason = "MIXED_OWNERSHIP";
    } else if (!derived.eligibleRoleIds.includes(suggestion.roleId)) {
      usable = false;
      unusableReason = "PROVIDER_ROLE_INELIGIBLE";
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
        const eligibleEmployers = new Set(
          employments
            .filter((entry) => derived.eligibleRoleIds.includes(entry.id))
            .map((entry) => entry.company),
        );
        const foreign = namedCompanies(suggestion.text, employments).filter(
          (name) => !eligibleEmployers.has(name),
        );
        if (foreign.length > 0) {
          usable = false;
          unusableReason = "FOREIGN_EMPLOYER";
        }
      }
    }
    suggestions.push({
      suggestionId,
      roleId: suggestion.roleId,
      text: suggestion.text,
      factIds: keptFactIds,
      priorityIds: links.kept,
      usable,
      unusableReason,
    });
    suggestionRecords.push({
      suggestionId,
      usable,
      unusableReason,
      keptFactIds,
      droppedFactIds,
      keptPriorityIds: links.kept,
      droppedPriorityIds: links.dropped,
      eligibleRoleIds: derived.eligibleRoleIds,
    });
  }

  // Contract §7.2 wholesale gate: zero LINKED priorities — no
  // kept inbound link survives on any kept angle or processed
  // suggestion — rejects the proposal. Linkage is counted
  // separately from usability so sparse plans (priorities with
  // no usable suggestions) still accept.
  let linkedCount = 0;
  for (const record of angleRecords) {
    linkedCount += record.keptPriorityIds.length;
  }
  for (const record of suggestionRecords) {
    linkedCount += record.keptPriorityIds.length;
  }
  if (linkedCount === 0) {
    return {
      ok: false,
      error: "UNTRACEABLE_PROPOSAL",
      detail: "proposal kept no same-plan priority links (zero linked priorities)",
    };
  }

  return {
    ok: true,
    plan: {
      schemaVersion: "step2-plan/v2",
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
      schemaVersion: STEP2_CORRECTION_VERSIONS.planValidation,
      droppedPriorities,
      angles: angleRecords,
      suggestions: suggestionRecords,
    },
  };
}
