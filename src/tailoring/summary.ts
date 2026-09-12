import { z } from "zod";
import { isRecord, pyString, pyTruthy } from "./primitives";
import { CandidateProfileInput } from "./schemas";
import { compareCodePoints, normalizeTerm } from "./text";

/**
 * Summary ports (`unioned_career_months`, `compose_summary`,
 * `verify_derivation`, `build_derived_text`) plus the baseline-preserving
 * `summary/v2` formula.
 *
 * Only three summary strategies exist: `verbatim` (quotes one approved
 * fact), `approved_variant` (validated in `validator.ts`), and
 * `derived_template` (fixed-formula slots, byte-reconstructable from the
 * persisted derivation manifest). `derived_template` has two formulas:
 * `summary/v1` (title + unioned tenure + proof fact) and `summary/v2`
 * (verbatim baseline narrative + evidence-derived focus terms). v2 applies
 * only when the profile carries a human-authored baseline summary;
 * profiles without one take the v1 path exactly as before, so every
 * oracle parity fixture stays on v1.
 */

export const FORMULA_VERSION = "summary/v1";
export const BASELINE_FORMULA_VERSION = "summary/v2";

const CONNECTOR_WITH = "with";
const CONNECTOR_SPECIALIZING = "Specializing in";

const IsoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) => {
      const [year, month, day] = value.split("-").map(Number) as [number, number, number];
      if (month < 1 || month > 12 || day < 1 || day > 31) {
        return false;
      }
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return day <= days;
    },
    { message: "expected a real calendar date" },
  );

function parseYearMonth(value: unknown): [number, number] | null {
  const text = pyTruthy(value) ? pyString(value).trim() : "";
  if (text === "") {
    return null;
  }
  const parts = text.replace(/\//g, "-").split("-");
  const ints: number[] = [];
  for (const part of parts.slice(0, 3)) {
    const trimmed = part.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      return null;
    }
    ints.push(Number(trimmed));
  }
  while (ints.length < 3) {
    ints.push(1);
  }
  const [year, month, day] = ints as [number, number, number];
  if (month < 1 || month > 12 || year < 1900 || year > 2100) {
    return null;
  }
  if (parts.length > 2 && !(day >= 1 && day <= 29) && month === 2) {
    return null;
  }
  if (parts.length > 2 && !(day >= 1 && day <= 31)) {
    return null;
  }
  return [year, month];
}

export interface CareerInterval {
  work_experience_id: string;
  start: string;
  end: string;
}

export interface CareerMonths {
  total_months: number;
  intervals: CareerInterval[];
}

const CareerMonthsEnvelope = z.object({
  workExperiences: z.unknown(),
  asOf: IsoDateString,
});

/** Port of `unioned_career_months`. */
export function unionedCareerMonths(input: { workExperiences: unknown; asOf: string }): CareerMonths {
  const envelope = CareerMonthsEnvelope.parse(input);
  const [asOfYear, asOfMonth] = envelope.asOf.split("-").map(Number) as [number, number];
  const asOfIdx = (asOfYear as number) * 12 + ((asOfMonth as number) - 1);
  const covered = new Set<number>();
  const intervals: CareerInterval[] = [];
  const experiences = Array.isArray(envelope.workExperiences) ? envelope.workExperiences : [];
  for (const raw of experiences) {
    if (!isRecord(raw)) {
      continue;
    }
    const start = parseYearMonth(raw["start_date"]);
    if (start === null) {
      continue;
    }
    const startIdx = start[0] * 12 + (start[1] - 1);
    let endIdx: number;
    if (!pyTruthy(raw["end_date"])) {
      endIdx = asOfIdx;
    } else {
      const end = parseYearMonth(raw["end_date"]);
      if (end === null) {
        continue;
      }
      endIdx = end[0] * 12 + (end[1] - 1);
    }
    endIdx = Math.min(endIdx, asOfIdx);
    if (endIdx < startIdx) {
      continue;
    }
    for (let idx = startIdx; idx <= endIdx; idx += 1) {
      covered.add(idx);
    }
    const endYear = Math.floor(endIdx / 12);
    const endMonth = (endIdx % 12) + 1;
    intervals.push({
      work_experience_id: pyTruthy(raw["id"]) ? pyString(raw["id"]) : "",
      start: `${String(start[0]).padStart(4, "0")}-${String(start[1]).padStart(2, "0")}`,
      end: `${String(endYear).padStart(4, "0")}-${String(endMonth).padStart(2, "0")}`,
    });
  }
  intervals.sort(
    (left, right) =>
      compareCodePoints(left.start, right.start) ||
      compareCodePoints(left.end, right.end) ||
      compareCodePoints(left.work_experience_id, right.work_experience_id),
  );
  return { total_months: covered.size, intervals };
}

function durationLabel(completedYears: unknown): string {
  const unit = completedYears === 1 ? "year" : "years";
  return `${CONNECTOR_WITH} ${pyString(completedYears)} ${unit} of professional experience`;
}

function oxfordJoin(terms: string[]): string {
  if (terms.length === 1) {
    return terms[0] as string;
  }
  if (terms.length === 2) {
    return `${terms[0]} and ${terms[1]}`;
  }
  return `${terms.slice(0, -1).join(", ")}, and ${terms[terms.length - 1]}`;
}

/** Port of `build_derived_text` (single source of truth, composer + validator). */
export function buildDerivedText(slotValues: Record<string, unknown>): string {
  const parts = [
    `${pyString(slotValues["title_family"])} ${durationLabel(slotValues["completed_years"])}.`,
    `${CONNECTOR_SPECIALIZING} ${pyString(slotValues["domains_techs"])}.`,
    pyString(slotValues["proof_point"]),
  ];
  if (pyTruthy(slotValues["target_label"])) {
    parts.push(pyString(slotValues["target_label"]));
  }
  return parts.join(" ");
}

/** `summary/v2` text builder (single source of truth, composer + validator). */
export function buildBaselineText(slotValues: Record<string, unknown>): string {
  const parts = [
    `${pyString(slotValues["narrative"])} ${CONNECTOR_SPECIALIZING} ${pyString(slotValues["domains_techs"])}.`,
  ];
  if (pyTruthy(slotValues["target_label"])) {
    parts.push(pyString(slotValues["target_label"]));
  }
  return parts.join(" ");
}

/** Targeting line, gated to the headline/target-title allow-list (v1 + v2). */
function targetLabelFor(headline: string, targetTitles: string[], jobTitle: string): string {
  const normalizedJob = normalizeTerm(jobTitle);
  const allowList = new Set([normalizeTerm(headline), ...targetTitles.map(normalizeTerm)]);
  if (normalizedJob !== "" && allowList.has(normalizedJob)) {
    return `Targeting ${jobTitle.trim()} roles.`;
  }
  return "";
}

type ApprovedFactRecord = CandidateProfileInput["verified_facts"][number];

/** Rank-ordered domain-term collection shared by both formulas. */
function collectDomainTerms(
  factsById: Map<string, ApprovedFactRecord>,
  ranked: string[],
  maxDomainTerms: number,
): { domainTerms: string[]; citedIds: string[] } {
  const seen = new Set<string>();
  const domainTerms: string[] = [];
  const citedIds: string[] = [];
  for (const fid of ranked) {
    const fact = factsById.get(fid) as ApprovedFactRecord;
    citedIds.push(fid);
    for (const tech of fact.technologies) {
      const term = tech.trim();
      const key = normalizeTerm(term);
      if (term !== "" && !seen.has(key)) {
        seen.add(key);
        domainTerms.push(term);
      }
    }
    if (domainTerms.length >= maxDomainTerms) {
      break;
    }
  }
  return { domainTerms, citedIds };
}

const ComposeEnvelope = z.object({
  profile: z.unknown(),
  rankedFactIds: z.array(z.string()),
  jobTitle: z.string(),
  asOf: IsoDateString,
  maxDomainTerms: z.number().int().optional(),
});

export interface SummaryDerivation {
  formula_version: string;
  /** v1-only: v2 carries no tenure arithmetic, only narrative + terms. */
  calculation_as_of?: string;
  employment_intervals?: CareerInterval[];
  total_months?: number;
  fact_ids: string[];
  proof_fact_id?: string;
  slot_values: Record<string, unknown>;
  final_text: string;
}

export interface SummaryResult {
  strategy: string;
  text: string;
  fact_ids: string[];
  derivation: SummaryDerivation | null;
  fallback_reason: string | null;
}

/** Port of `compose_summary`, dispatching to v1 or the baseline v2 formula. */
export function composeSummary(input: {
  profile: unknown;
  rankedFactIds: unknown;
  jobTitle: unknown;
  asOf: string;
  maxDomainTerms?: number;
}): SummaryResult {
  const envelope = ComposeEnvelope.parse(input);
  const profile = CandidateProfileInput.parse(envelope.profile);
  const maxDomainTerms = envelope.maxDomainTerms ?? 4;
  const factsById = new Map<string, (typeof profile.verified_facts)[number]>();
  for (const fact of profile.verified_facts) {
    if (fact.verification_status === "approved") {
      factsById.set(fact.fact_id, fact);
    }
  }
  const ranked = envelope.rankedFactIds.filter((fid) => factsById.has(fid));
  if (ranked.length === 0) {
    return { strategy: "none", text: "", fact_ids: [], derivation: null, fallback_reason: "NO_EVIDENCE" };
  }
  const narrative = (profile.summary ?? "").trim();
  if (narrative !== "") {
    return composeBaselineSummary({
      profile,
      factsById,
      ranked,
      narrative,
      jobTitle: envelope.jobTitle,
      asOf: envelope.asOf,
      maxDomainTerms,
    });
  }
  return composeDerivedV1({
    profile,
    factsById,
    ranked,
    jobTitle: envelope.jobTitle,
    asOf: envelope.asOf,
    maxDomainTerms,
  });
}

interface ComposerArgs {
  profile: CandidateProfileInput;
  factsById: Map<string, ApprovedFactRecord>;
  ranked: string[];
  jobTitle: string;
  maxDomainTerms: number;
}

/** `summary/v2`: verbatim baseline narrative plus evidence focus terms. */
function composeBaselineSummary(
  args: ComposerArgs & { narrative: string; asOf: string },
): SummaryResult {
  const { domainTerms, citedIds } = collectDomainTerms(
    args.factsById,
    args.ranked,
    args.maxDomainTerms,
  );
  if (domainTerms.length === 0) {
    // No usable evidence terms: the v2 shape cannot be built honestly,
    // so delegate to the v1 path (derived or verbatim fallback).
    return composeDerivedV1(args);
  }
  const headline = (args.profile.headline ?? "").trim();
  const targetTitles = args.profile.target_titles.filter((title) => title.trim() !== "");
  const slotValues: Record<string, unknown> = {
    narrative: args.narrative,
    domains_techs: oxfordJoin(domainTerms.slice(0, args.maxDomainTerms)),
    target_label: targetLabelFor(headline, targetTitles, args.jobTitle),
  };
  const finalText = buildBaselineText(slotValues);
  return {
    strategy: "derived_template",
    text: finalText,
    fact_ids: citedIds,
    derivation: {
      formula_version: BASELINE_FORMULA_VERSION,
      fact_ids: citedIds,
      slot_values: slotValues,
      final_text: finalText,
    },
    fallback_reason: null,
  };
}

/** `summary/v1` composer (oracle behavior, extracted verbatim). */
function composeDerivedV1(args: ComposerArgs & { asOf: string }): SummaryResult {
  const { profile, factsById, ranked, jobTitle, asOf, maxDomainTerms } = args;
  const headline = (profile.headline ?? "").trim();
  const targetTitles = profile.target_titles.filter((title) => title.trim() !== "");
  const titleFamily = headline !== "" ? headline : (targetTitles[0] ?? "");
  if (titleFamily === "") {
    const fact = factsById.get(ranked[0] as string) as (typeof profile.verified_facts)[number];
    return {
      strategy: "verbatim",
      text: fact.text,
      fact_ids: [fact.fact_id],
      derivation: null,
      fallback_reason: "NO_TITLE",
    };
  }

  const { total_months: totalMonths, intervals } = unionedCareerMonths({
    workExperiences: profile.work_experience,
    asOf,
  });
  const completedYears = Math.floor(totalMonths / 12);
  if (completedYears < 1) {
    const fact = factsById.get(ranked[0] as string) as (typeof profile.verified_facts)[number];
    return {
      strategy: "verbatim",
      text: fact.text,
      fact_ids: [fact.fact_id],
      derivation: null,
      fallback_reason: "THIN_TENURE",
    };
  }

  const { domainTerms, citedIds } = collectDomainTerms(factsById, ranked, maxDomainTerms);
  if (domainTerms.length === 0) {
    const fact = factsById.get(ranked[0] as string) as (typeof profile.verified_facts)[number];
    return {
      strategy: "verbatim",
      text: fact.text,
      fact_ids: [fact.fact_id],
      derivation: null,
      fallback_reason: "NO_DOMAINS",
    };
  }
  const cappedTerms = domainTerms.slice(0, maxDomainTerms);

  const proofFact = factsById.get(ranked[0] as string) as (typeof profile.verified_facts)[number];
  const proofPoint = proofFact.text;

  const slotValues: Record<string, unknown> = {
    title_family: titleFamily,
    completed_years: completedYears,
    domains_techs: oxfordJoin(cappedTerms),
    proof_point: proofPoint,
    target_label: targetLabelFor(headline, targetTitles, jobTitle),
  };
  const finalText = buildDerivedText(slotValues);
  return {
    strategy: "derived_template",
    text: finalText,
    fact_ids: citedIds,
    derivation: {
      formula_version: FORMULA_VERSION,
      calculation_as_of: asOf,
      employment_intervals: intervals,
      total_months: totalMonths,
      fact_ids: citedIds,
      proof_fact_id: proofFact.fact_id,
      slot_values: slotValues,
      final_text: finalText,
    },
    fallback_reason: null,
  };
}

const VerifyEnvelope = z.object({
  manifest: z.unknown(),
  profile: z.unknown(),
});

export interface DerivationValidation {
  valid: boolean;
  errors: string[];
}

/** Shared domain-term evidence check (v1 + v2 use identical rules). */
function checkDomainTerms(
  slots: Record<string, unknown>,
  factsById: Map<string, ApprovedFactRecord>,
  manifestFactIds: unknown[],
  errors: string[],
): void {
  const evidenceTexts: string[] = [];
  const evidenceTechs: string[] = [];
  for (const fid of manifestFactIds) {
    if (typeof fid !== "string" || !factsById.has(fid)) {
      continue;
    }
    const fact = factsById.get(fid) as ApprovedFactRecord;
    evidenceTexts.push(fact.text);
    evidenceTechs.push(...fact.technologies);
  }
  const domainsRaw = "domains_techs" in slots ? pyString(slots["domains_techs"]) : "";
  for (const raw of domainsRaw.split(",")) {
    const term = raw.trim().replace(/^(and|or)\s+/, "");
    if (term === "") {
      continue;
    }
    if (!evidenceTexts.includes(term) && !evidenceTechs.includes(term) && !evidenceTexts.some((text) => text.includes(term))) {
      errors.push(`Derivation domain term '${term}' is not verbatim fact evidence.`);
    }
  }
}

function approvedFactsById(profile: CandidateProfileInput): Map<string, ApprovedFactRecord> {
  const factsById = new Map<string, ApprovedFactRecord>();
  for (const fact of profile.verified_facts) {
    if (fact.verification_status === "approved") {
      factsById.set(fact.fact_id, fact);
    }
  }
  return factsById;
}

/** `summary/v2` verifier: narrative verbatim, terms evidenced, rebuildable. */
function verifyBaselineDerivation(
  manifest: Record<string, unknown>,
  profile: CandidateProfileInput,
): DerivationValidation {
  const errors: string[] = [];
  const slots = isRecord(manifest["slot_values"]) ? manifest["slot_values"] : {};
  const narrative = (profile.summary ?? "").trim();
  if (narrative === "") {
    errors.push("Baseline derivation requires a profile baseline summary.");
  } else if (pyString("narrative" in slots ? slots["narrative"] : undefined) !== narrative) {
    errors.push("Derivation narrative must equal the profile baseline summary verbatim.");
  }
  const factsById = approvedFactsById(profile);
  let manifestFactIds: unknown[] = [];
  if (!Array.isArray(manifest["fact_ids"]) || manifest["fact_ids"].length === 0) {
    errors.push("Derivation must cite at least one approved fact_id.");
  } else {
    manifestFactIds = manifest["fact_ids"] as unknown[];
  }
  for (const fid of manifestFactIds) {
    if (typeof fid !== "string" || !factsById.has(fid)) {
      errors.push(`Derivation cites unknown or unapproved fact_id '${typeof fid === "string" ? fid : pyString(fid)}'.`);
    }
  }
  checkDomainTerms(slots, factsById, manifestFactIds, errors);
  if (errors.length > 0) {
    return { valid: false, errors };
  }
  const rebuilt = buildBaselineText(slots);
  if (rebuilt !== (manifest["final_text"] ?? null)) {
    return { valid: false, errors: ["Derivation final_text is not byte-for-byte reconstructable."] };
  }
  return { valid: true, errors: [] };
}

/** Port of `verify_derivation`, extended with the `summary/v2` formula. */
export function verifyDerivation(input: { manifest: unknown; profile: unknown }): DerivationValidation {
  const envelope = VerifyEnvelope.parse(input);
  if (!isRecord(envelope.manifest)) {
    return { valid: false, errors: ["Summary derivation manifest must be an object."] };
  }
  const manifest = envelope.manifest;
  const profile = CandidateProfileInput.parse(envelope.profile);
  if (manifest["formula_version"] === BASELINE_FORMULA_VERSION) {
    return verifyBaselineDerivation(manifest, profile);
  }
  if (manifest["formula_version"] !== FORMULA_VERSION) {
    return {
      valid: false,
      errors: [`Unsupported summary formula '${pyString(manifest["formula_version"])}'.`],
    };
  }
  const asOfRaw = manifest["calculation_as_of"];
  const asOfParsed = IsoDateString.safeParse(typeof asOfRaw === "string" ? asOfRaw : "");
  if (!asOfParsed.success) {
    return { valid: false, errors: ["Derivation has an invalid calculation_as_of date."] };
  }
  const errors: string[] = [];
  const { total_months: totalMonths } = unionedCareerMonths({
    workExperiences: profile.work_experience,
    asOf: asOfParsed.data,
  });
  if (totalMonths !== manifest["total_months"]) {
    errors.push("Derivation total_months does not match unioned employment intervals.");
  }
  const slots = isRecord(manifest["slot_values"]) ? manifest["slot_values"] : {};
  if (slots["completed_years"] !== Math.floor(totalMonths / 12)) {
    errors.push("Derivation completed_years is inconsistent with unioned months.");
  }

  const headline = (profile.headline ?? "").trim();
  const allowList = [headline, ...profile.target_titles];
  if (!allowList.includes(slots["title_family"] as string)) {
    errors.push("Derivation title_family is outside the canonical allow-list.");
  }

  const factsById = new Map<string, (typeof profile.verified_facts)[number]>();
  for (const fact of profile.verified_facts) {
    if (fact.verification_status === "approved") {
      factsById.set(fact.fact_id, fact);
    }
  }
  let manifestFactIds: unknown[] = [];
  if (!Array.isArray(manifest["fact_ids"]) || manifest["fact_ids"].length === 0) {
    errors.push("Derivation must cite at least one approved fact_id.");
  } else {
    manifestFactIds = manifest["fact_ids"] as unknown[];
  }
  for (const fid of manifestFactIds) {
    if (typeof fid !== "string" || !factsById.has(fid)) {
      errors.push(`Derivation cites unknown or unapproved fact_id '${typeof fid === "string" ? fid : pyString(fid)}'.`);
    }
  }

  checkDomainTerms(slots, factsById, manifestFactIds, errors);

  const proofId = manifest["proof_fact_id"];
  const proofFact = typeof proofId === "string" ? (factsById.get(proofId) ?? null) : null;
  if (proofFact === null) {
    errors.push("Derivation proof_fact_id must reference a cited approved fact.");
  } else if ((slots["proof_point"] ?? null) !== proofFact.text) {
    errors.push("Derivation proof_point must be one complete verbatim fact.");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  const rebuilt = buildDerivedText(slots);
  if (rebuilt !== (manifest["final_text"] ?? null)) {
    return { valid: false, errors: ["Derivation final_text is not byte-for-byte reconstructable."] };
  }
  return { valid: true, errors: [] };
}
