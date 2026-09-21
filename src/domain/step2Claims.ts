import { canonicalText } from "./canonical";
import type { MasterBullet } from "./step2";

/**
 * Claim-validation policy `step2-claims/1` string rules (WO-1.3-S2-A
 * §7): reason codes, normalization, entity filters, and plan-support
 * recomputation. Hash-free by the domain purity guard; the hashing
 * verdict computation lives in `../tailoring/step2policy.ts`.
 */

/** Stable machine reason codes; human copy lives in S2-C renderers. */
export const STEP2_REASONS = {
  CHRONOLOGY: "CHRONOLOGY",
  UNKNOWN_FACT: "UNKNOWN_FACT",
  FACT_NOT_APPROVED: "FACT_NOT_APPROVED",
  FOREIGN_FACT: "FOREIGN_FACT",
  FOREIGN_ROLE_FACT: "FOREIGN_ROLE_FACT",
  NEW_METRIC: "NEW_METRIC",
  NEW_EMPLOYER: "NEW_EMPLOYER",
  REWORDED: "REWORDED",
} as const;
export type Step2Reason =
  (typeof STEP2_REASONS)[keyof typeof STEP2_REASONS];

/** Normalized claim key: NFC/LF/NUL-strip/trim, case- and spacing-exact. */
export function claimKey(text: string): string {
  return canonicalText(text);
}

const NUMBER_PATTERN = /\d[\d,./%]*/g;

/** Digit-sequences in `text` absent as substrings from every cited text. */
export function novelNumbers(text: string, citedTexts: string[]): string[] {
  const candidates = text.match(NUMBER_PATTERN) ?? [];
  const seen = new Set<string>();
  const novel: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (citedTexts.every((cited) => cited.includes(candidate) === false)) {
      novel.push(candidate);
    }
  }
  return novel;
}

/** Payload company names appearing in `text` (case-folded substring). */
export function namedCompanies(
  text: string,
  employments: Array<{ company: string }>,
): string[] {
  const folded = text.toLocaleLowerCase("en");
  const found: string[] = [];
  for (const employment of employments) {
    const name = employment.company.trim();
    if (
      name !== "" &&
      folded.includes(name.toLocaleLowerCase("en")) &&
      found.includes(name) === false
    ) {
      found.push(name);
    }
  }
  return found;
}

export interface Step2SnapshotFact {
  factId: string;
  statement: string;
  verification: string;
  profileVersionId: string;
  employmentId: string | null;
  metrics?: string[];
  technologies?: string[];
}

export interface Step2SegmentInput {
  segmentId: string;
  kind: "summary" | "bullet";
  roleId: string | null;
  text: string;
  citedFactIds: string[];
  /**
   * Allowlisted derivation manifest (the active tree's allowlist is
   * summary final_text/fact_ids manifest equality). Any other shape
   * is ignored — never trusted.
   */
  derivation?: { finalText: string; factIds: string[] };
}

export interface ValidateStep2SegmentsInput {
  segments: Step2SegmentInput[];
  planId: string;
  planHash: string;
  draftHash: string;
  boundProfileVersionId: string;
  snapshotFacts: Step2SnapshotFact[];
  planTexts: Array<{ textId: string; text: string }>;
  master: MasterBullet[];
  employments: Array<{ id: string; company: string }>;
  versionCreatedAt: string;
  planAcceptedAt: string;
  now: string;
}

export interface RecomputedSupport {
  support: "supported" | "related" | "gap";
  keptFactIds: string[];
  droppedFactIds: Array<{ factId: string; reason: string }>;
}

/**
 * Recompute one priority's support badge (§7.2): drop cited ids that
 * are unknown, unapproved, or foreign-owned; `supported` when ≥1 kept
 * id is employment-linked, `related` when ≥1 kept and all are
 * transferable, else `gap`. Badges guide display; only §7.1 verdicts
 * gate generation.
 */
export function recomputePrioritySupport(
  citedFactIds: string[],
  factsById: Map<string, Step2SnapshotFact>,
  boundProfileVersionId: string,
): RecomputedSupport {
  const kept: string[] = [];
  const dropped: Array<{ factId: string; reason: string }> = [];
  for (const factId of citedFactIds) {
    const fact = factsById.get(factId);
    if (fact === undefined) {
      dropped.push({ factId, reason: STEP2_REASONS.UNKNOWN_FACT });
    } else if (fact.verification !== "APPROVED") {
      dropped.push({ factId, reason: STEP2_REASONS.FACT_NOT_APPROVED });
    } else if (fact.profileVersionId !== boundProfileVersionId) {
      dropped.push({ factId, reason: STEP2_REASONS.FOREIGN_FACT });
    } else {
      kept.push(factId);
    }
  }
  if (kept.length === 0) {
    return { support: "gap", keptFactIds: kept, droppedFactIds: dropped };
  }
  const linked = kept.some(
    (factId) =>
      (factsById.get(factId) as Step2SnapshotFact).employmentId !== null,
  );
  return {
    support: linked ? "supported" : "related",
    keptFactIds: kept,
    droppedFactIds: dropped,
  };
}
