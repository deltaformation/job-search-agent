import { z } from "zod";
import { sha256HexUtf8 } from "./hash";
import { isRecord, pyString, pyTruthy } from "./primitives";
import { CandidateProfileInput } from "./schemas";
import { verifyDerivation } from "./summary";
import { compareCodePoints } from "./text";

/**
 * ClaimValidator port (`services/documents/validator.py`).
 *
 * Rule checks mirror the oracle line by line, including message text, check
 * order, and alias handling (`status`/`matched_fact_ids`). Python semantics
 * mirrored throughout: `.get` defaults, membership tests, set ordering
 * normalized to sorted (matching the R4-B fixture normalization), and
 * code-point string order.
 *
 * Deliberate fail-closed divergences (all exercised by adversarial tests):
 * inputs where the oracle itself crashes (`AttributeError`/`TypeError` on
 * mistyped values) produce structured errors instead of throwing, except a
 * malformed candidate profile (our own snapshot data), which throws
 * `ZodError` like any other schema violation.
 */

const VALID_MATCH_STATUS = ["matched", "partial", "gap", "unsupported"];
const VALID_IMPORTANCE = ["required", "preferred", "unspecified"];
const VALID_CATEGORIES = [
  "experience",
  "skill",
  "responsibility",
  "domain",
  "location",
  "compensation",
  "screening",
  "other",
];
const VALID_REVIEW_STATUS = ["proposed", "confirmed"];

function sortedAllowed(values: string[]): string {
  return `{${[...values]
    .sort(compareCodePoints)
    .map((value) => `'${value}'`)
    .join(", ")}}`;
}

export interface ApprovedFact {
  fact_id: string;
  work_experience_id?: string | null;
  category: string;
  text: string;
  technologies: string[];
  metrics: string[];
  verification_status: string;
  source?: string | null;
}

function approvedFactMap(profile: CandidateProfileInput): Map<string, ApprovedFact> {
  const map = new Map<string, ApprovedFact>();
  for (const fact of profile.verified_facts) {
    if (fact.verification_status === "approved") {
      map.set(fact.fact_id, {
        fact_id: fact.fact_id,
        work_experience_id: fact.work_experience_id,
        category: fact.category,
        text: fact.text,
        technologies: [...fact.technologies],
        metrics: [...fact.metrics],
        verification_status: fact.verification_status,
        source: fact.source,
      });
    }
  }
  return map;
}

const RequirementsEnvelope = z.object({
  profile: z.unknown(),
  requirements: z.unknown(),
  jdText: z.string().optional(),
});

export interface RequirementsValidation {
  valid: boolean;
  errors: string[];
}

/** Port of `ClaimValidator.validate_requirement_analysis`. */
export function validateRequirements(input: {
  profile: unknown;
  requirements: unknown;
  jdText?: string;
}): RequirementsValidation {
  const envelope = RequirementsEnvelope.parse(input);
  if (!Array.isArray(envelope.requirements)) {
    return { valid: false, errors: ["Requirements must be a list."] };
  }
  const profile = CandidateProfileInput.parse(envelope.profile);
  const verified = approvedFactMap(profile);
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const rawReq of envelope.requirements) {
    if (!isRecord(rawReq)) {
      errors.push("Requirement must be an object.");
      continue;
    }
    const req = rawReq;
    const rid = req["requirement_id"];
    if (typeof rid !== "string" || rid === "" || seen.has(rid)) {
      errors.push("Requirement IDs must be nonempty and unique.");
    } else {
      seen.add(rid);
    }
    const ridText = pyString(rid);

    const statusRaw = pyTruthy(req["match_status"]) ? req["match_status"] : req["status"];
    const status = statusRaw === undefined ? undefined : statusRaw;
    if (typeof status !== "string" || !VALID_MATCH_STATUS.includes(status)) {
      errors.push(
        `Requirement '${ridText}' has an invalid match_status: '${pyString(status)}'. ` +
          `Allowed: ${sortedAllowed(VALID_MATCH_STATUS)}`,
      );
    }

    const category = req["category"] === undefined ? "experience" : req["category"];
    if (typeof category !== "string" || !VALID_CATEGORIES.includes(category)) {
      errors.push(
        `Requirement '${ridText}' has invalid category '${pyString(req["category"])}'. ` +
          `Allowed: ${sortedAllowed(VALID_CATEGORIES)}`,
      );
    }

    const importance = req["importance"] === undefined ? "required" : req["importance"];
    if (typeof importance !== "string" || !VALID_IMPORTANCE.includes(importance)) {
      errors.push(
        `Requirement '${ridText}' has invalid importance '${pyString(req["importance"])}'. ` +
          `Allowed: ${sortedAllowed(VALID_IMPORTANCE)}`,
      );
    }

    const review = req["review_status"] === undefined ? "proposed" : req["review_status"];
    if (typeof review !== "string" || !VALID_REVIEW_STATUS.includes(review)) {
      errors.push(
        `Requirement '${ridText}' has invalid review_status '${pyString(req["review_status"])}'. ` +
          `Allowed: ${sortedAllowed(VALID_REVIEW_STATUS)}`,
      );
    }

    const quote = req["jd_quote"];
    if (
      typeof quote !== "string" ||
      quote.trim() === "" ||
      (envelope.jdText !== undefined && !envelope.jdText.includes(quote))
    ) {
      errors.push(`Requirement '${ridText}' must quote exact JD text.`);
    }

    const idsRaw =
      "evidence_fact_ids" in req ? req["evidence_fact_ids"] : (req["matched_fact_ids"] ?? []);
    if (!Array.isArray(idsRaw) || idsRaw.some((fid) => typeof fid !== "string")) {
      errors.push(`Requirement '${ridText}' requires a list of fact IDs.`);
      continue;
    }
    const ids = idsRaw as string[];
    if ((status === "matched" || status === "partial") && ids.length === 0) {
      errors.push(
        `Requirement '${ridText}' has no matched_fact_ids / evidence_fact_ids (empty evidence).`,
      );
    }
    if ((status === "unsupported" || status === "gap") && ids.length > 0) {
      errors.push(
        `Requirement '${ridText}' has match_status '${status}' but contains evidence fact IDs.`,
      );
    }
    for (const fid of ids) {
      if (!verified.has(fid)) {
        errors.push(`Requirement '${ridText}' references unknown or unapproved fact_id '${fid}'.`);
      }
    }

    const quotesRaw = req["evidence_quotes"] ?? [];
    if ((status === "unsupported" || status === "gap") && pyTruthy(req["evidence_quotes"])) {
      errors.push(
        `Requirement '${ridText}' has match_status '${status}' but contains evidence quotes.`,
      );
    }
    if (status === "matched" || status === "partial") {
      if (!Array.isArray(quotesRaw) || quotesRaw.length === 0) {
        errors.push(`Requirement '${ridText}' requires evidence_quotes for every proposed match.`);
      } else {
        const citedTexts = new Set(
          ids.filter((fid) => verified.has(fid)).map((fid) => (verified.get(fid) as ApprovedFact).text),
        );
        const quoteSet = new Set(
          (quotesRaw as unknown[]).map((entry) =>
            typeof entry === "string" ? entry : pyString(entry),
          ),
        );
        const equal =
          quoteSet.size === citedTexts.size && [...quoteSet].every((entry) => citedTexts.has(entry));
        if (!equal) {
          errors.push(
            `Requirement '${ridText}' evidence_quotes must exactly match its cited fact texts.`,
          );
        }
      }
    }

    if (status === "matched" && ids.length > 0) {
      const quoted = typeof quote === "string" ? quote : null;
      const exact = ids.some((fid) => (verified.get(fid)?.text ?? null) === quoted);
      if (!exact && review !== "confirmed") {
        errors.push(`Requirement '${ridText}': semantic matches must be 'partial' pending human review.`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

const DraftEnvelope = z.object({
  profile: z.unknown(),
  draft: z.unknown(),
  variants: z.unknown().optional(),
});

export interface DraftReport {
  is_valid: boolean;
  total_claims: number;
  validated_claims: number;
  errors: string[];
  verified_facts_referenced: string[];
}

export interface DraftValidation {
  valid: boolean;
  report: DraftReport;
}

function validateVariant(
  claim: Record<string, unknown>,
  text: unknown,
  ids: string[],
  profile: CandidateProfileInput,
  verified: Map<string, ApprovedFact>,
  variants: Array<Record<string, unknown>>,
): string[] {
  const errors: string[] = [];
  const variantId = claim["variant_id"];
  const lookup = pyTruthy(variantId) ? variants.find((entry) => pyString(entry["id"]) === pyString(variantId)) : undefined;
  const variant = lookup ?? null;
  if (variant === null) {
    return [`Unknown wording variant '${pyString(variantId)}'.`];
  }
  if (variant["review_status"] !== "approved") {
    errors.push(`Wording variant '${pyString(variantId)}' is not human-approved.`);
  }
  if ((text ?? null) !== (variant["variant_text"] ?? null)) {
    errors.push(`Claim text does not match approved variant '${pyString(variantId)}'.`);
  }
  const variantText =
    "variant_text" in variant ? pyString(variant["variant_text"]) : "";
  const actual = sha256HexUtf8(variantText);
  if (actual !== variant["content_hash"]) {
    errors.push(`Wording variant '${pyString(variantId)}' hash mismatch.`);
  }
  if (pyString(variant["candidate_id"]) !== pyString(profile.id)) {
    errors.push(`Wording variant '${pyString(variantId)}' belongs to another candidate.`);
  }
  const variantFactIds = variant["fact_ids"] ?? [];
  const sortedVariant = Array.isArray(variantFactIds)
    ? [...variantFactIds].map(pyString).sort(compareCodePoints)
    : null;
  const sortedIds = [...ids].sort(compareCodePoints);
  if (
    sortedVariant === null ||
    (Array.isArray(variantFactIds) && variantFactIds.length === 0) ||
    sortedVariant.length !== sortedIds.length ||
    sortedVariant.some((fid, index) => fid !== sortedIds[index])
  ) {
    errors.push(`Wording variant '${pyString(variantId)}' fact binding must equal claim fact_ids.`);
  }
  if (Array.isArray(variantFactIds)) {
    for (const fid of variantFactIds) {
      const key = typeof fid === "string" ? fid : pyString(fid);
      if (!verified.has(key)) {
        errors.push(`Wording variant '${pyString(variantId)}' cites unapproved fact_id '${key}'.`);
      }
    }
  }
  return errors;
}

function validateExperienceBinding(
  claim: Record<string, unknown>,
  fact: ApprovedFact,
  profile: CandidateProfileInput,
  errors: string[],
): boolean {
  const expKey = pyString(fact.work_experience_id ?? null);
  const exp =
    profile.work_experience.find((entry) => "id" in entry && pyString(entry.id ?? null) === expKey) ??
    null;
  if (exp === null) {
    errors.push("Experience fact has no candidate-owned employment record.");
  } else {
    if ((claim["company"] ?? null) !== (exp.company ?? null)) {
      errors.push("Misattributed employer.");
    }
    if ((claim["role"] ?? null) !== (exp.role ?? null) || (claim["entity_id"] ?? null) !== (exp.id ?? null)) {
      errors.push("Role or employment identity does not match the cited fact.");
    }
    const expectedEnd =
      exp.end_date !== null && exp.end_date !== undefined && exp.end_date !== ""
        ? String(exp.end_date)
        : exp.is_current === true
          ? "Present"
          : "";
    const expectedStart = exp.start_date === null || exp.start_date === undefined ? "None" : String(exp.start_date);
    const dates = claim["dates"];
    const datesMatch =
      isRecord(dates) &&
      Object.keys(dates).length === 2 &&
      (dates["start"] ?? null) === expectedStart &&
      (dates["end"] ?? null) === expectedEnd;
    if (!datesMatch) {
      errors.push("Employment dates do not match canonical evidence.");
    }
  }
  return errors.length === 0;
}

export interface ClaimValidation {
  valid: boolean;
  errors: string[];
}

/**
 * S2-D allowlisted edited text for one claim: exact accepted bytes
 * plus the frozen verdict's responsible fact binding. The worker
 * builds this list from the frozen validation row — never from
 * live workspace state — so the draft validator independently
 * re-pins every edited claim to its verdict.
 */
export interface EditedPlanClaimText {
  text: string;
  factIds: string[];
}

/** Port of `ClaimValidator.validate_claim`. */
export function validateClaim(input: {
  profile: unknown;
  claim: unknown;
  variants?: unknown;
  editedPlan?: { texts: EditedPlanClaimText[] };
}): ClaimValidation {
  const envelope = z
    .object({
      profile: z.unknown(),
      claim: z.unknown(),
      variants: z.unknown().optional(),
      editedPlan: z.unknown().optional(),
    })
    .parse(input);
  const editedPlan =
    isRecord(envelope.editedPlan) && Array.isArray(envelope.editedPlan["texts"])
      ? (envelope.editedPlan as { texts: EditedPlanClaimText[] })
      : undefined;
  if (!isRecord(envelope.claim)) {
    return { valid: false, errors: ["Claim must be an object."] };
  }
  const profile = CandidateProfileInput.parse(envelope.profile);
  const verified = approvedFactMap(profile);
  const rawVariants = envelope.variants;
  const variants = Array.isArray(rawVariants) ? rawVariants.filter(isRecord) : [];
  const claim = envelope.claim as Record<string, unknown>;
  const errors: string[] = [];
  const section = claim["section"];

  const idsRaw = claim["fact_ids"] ?? [];
  if (!Array.isArray(idsRaw) || idsRaw.some((fid) => typeof fid !== "string")) {
    return { valid: false, errors: ["fact_ids must be a list of strings."] };
  }
  const text = claim["text"];
  if (typeof text !== "string" || text.trim() === "") {
    errors.push("Claim text must be nonempty.");
  }
  const strategy = claim["generation_strategy"] === undefined ? "verbatim" : claim["generation_strategy"];
  const editedPlanAllowed = strategy === "edited_plan" && editedPlan !== undefined;
  if (
    strategy !== "verbatim" &&
    strategy !== "derived_template" &&
    strategy !== "approved_variant" &&
    !editedPlanAllowed
  ) {
    errors.push("Only verbatim, derived_template, and approved_variant strategies are supported.");
    return { valid: false, errors };
  }

  if (section === "experience" || section === "summary") {
    const expIds = claim["fact_ids"] ?? [];
    // Correction master summaries honestly cite no facts; the
    // edited_plan branch below still demands an exact
    // text+binding allowlist match, so an empty binding matches
    // only an allowlisted empty binding. Every other strategy
    // and section keeps the ≥1 gate bit-identically.
    const anchorlessSummaryOk = section === "summary" && strategy === "edited_plan";
    if (
      !Array.isArray(expIds) ||
      expIds.some((fid) => typeof fid !== "string") ||
      (expIds.length === 0 && !anchorlessSummaryOk)
    ) {
      return { valid: false, errors: [...errors, "Claim must cite at least one approved fact_id."] };
    }
    const ids = expIds as string[];
    if (strategy === "derived_template") {
      if (section !== "summary") {
        return { valid: false, errors: [...errors, "derived_template is allowed only for the summary."] };
      }
      const manifest = isRecord(claim["derivation"]) ? (claim["derivation"] as Record<string, unknown>) : {};
      const manifestErrors = verifyDerivation({ manifest, profile });
      errors.push(...manifestErrors.errors);
      const manifestText = isRecord(claim["derivation"])
        ? ((claim["derivation"] as Record<string, unknown>)["final_text"] ?? null)
        : null;
      if ((text ?? null) !== manifestText) {
        errors.push("Summary text must equal its derivation final_text.");
      }
      const manifestIdsRaw =
        isRecord(claim["derivation"]) ? ((claim["derivation"] as Record<string, unknown>)["fact_ids"] ?? []) : [];
      const manifestIds = Array.isArray(manifestIdsRaw)
        ? [...manifestIdsRaw].map((fid) => (typeof fid === "string" ? fid : pyString(fid))).sort(compareCodePoints)
        : typeof manifestIdsRaw === "string"
          ? [...manifestIdsRaw].sort(compareCodePoints)
          : null;
      const sortedIds = [...ids].sort(compareCodePoints);
      if (
        manifestIds === null ||
        manifestIds.length !== sortedIds.length ||
        manifestIds.some((fid, index) => fid !== sortedIds[index])
      ) {
        errors.push("Summary fact_ids must equal its derivation fact_ids.");
      }
      return { valid: errors.length === 0, errors };
    }
    if (strategy === "approved_variant") {
      errors.push(...validateVariant(claim, text, ids, profile, verified, variants));
      if (section === "experience") {
        const firstFact = verified.get(ids[0] as string) ?? null;
        if (firstFact === null) {
          return { valid: false, errors: [...errors, "Variant cites an unapproved fact_id."] };
        }
        const ok = validateExperienceBinding(claim, firstFact, profile, errors);
        return { valid: ok, errors };
      }
      return { valid: errors.length === 0, errors };
    }
    if (strategy === "edited_plan") {
      // S2-D: the claim must repeat one allowlisted edited text with
      // exactly its frozen fact binding. Approved-ness, tamper, and
      // attribution checks below mirror the verbatim rules; the
      // allowlist itself was pinned to supported verdicts upstream.
      const texts = editedPlan?.texts ?? [];
      const sortedIds = [...ids].sort(compareCodePoints);
      const bound = texts.find(
        (entry) =>
          entry.text === text &&
          entry.factIds.length === sortedIds.length &&
          [...entry.factIds].sort(compareCodePoints).every((fid, index) => fid === sortedIds[index]),
      );
      if (bound === undefined) {
        return {
          valid: false,
          errors: [
            ...errors,
            "Claim text is not an allowlisted edited-plan text with its frozen fact binding.",
          ],
        };
      }
      for (const fid of ids) {
        if (!verified.has(fid)) {
          return {
            valid: false,
            errors: [...errors, `Edited-plan claim cites unapproved fact_id '${fid}'.`],
          };
        }
      }
      const unionMetrics = new Set<string>();
      const unionTechnologies = new Set<string>();
      for (const fid of ids) {
        const fact = verified.get(fid) as ApprovedFact;
        for (const metric of fact.metrics) {
          unionMetrics.add(metric);
        }
        for (const technology of fact.technologies) {
          unionTechnologies.add(technology);
        }
      }
      const tamperChecks = [
        ["claimed_metrics", unionMetrics, "Metric tampering"],
        ["claimed_technologies", unionTechnologies, "Unverified technology"],
      ] as const;
      for (const [claimKey, allowed, label] of tamperChecks) {
        const values = claim[claimKey] ?? [];
        if (!Array.isArray(values)) {
          errors.push(`${claimKey} must be a list.`);
        } else {
          for (const value of values) {
            if (!allowed.has(typeof value === "string" ? value : pyString(value))) {
              errors.push(`${label} '${pyString(value)}' is not present in the cited facts.`);
            }
          }
        }
      }
      if (section === "experience") {
        const expKey = pyString(claim["entity_id"] ?? null);
        const exp =
          profile.work_experience.find(
            (entry) => "id" in entry && pyString(entry.id ?? null) === expKey,
          ) ?? null;
        if (exp === null) {
          errors.push("Experience claim names no candidate-owned employment record.");
          return { valid: false, errors };
        }
        const pseudoFact: ApprovedFact = {
          fact_id: ids[0] as string,
          work_experience_id: pyString(exp.id ?? null),
          category: "",
          text: typeof text === "string" ? text : "",
          technologies: [],
          metrics: [],
          verification_status: "approved",
        };
        const ok = validateExperienceBinding(claim, pseudoFact, profile, errors);
        return { valid: ok, errors };
      }
      return { valid: errors.length === 0, errors };
    }
    const verbatimIds = claim["fact_ids"] ?? [];
    if (
      !Array.isArray(verbatimIds) ||
      verbatimIds.length !== 1 ||
      typeof verbatimIds[0] !== "string"
    ) {
      return { valid: false, errors: [...errors, "Each verbatim claim must cite exactly one approved fact_id."] };
    }
    const fact = verified.get(verbatimIds[0] as string) ?? null;
    if (fact === null) {
      return { valid: false, errors: [...errors, `Unknown or unapproved fact_id '${verbatimIds[0]}'.`] };
    }
    if ((text ?? null) !== fact.text) {
      errors.push("Text differs from approved fact text under verbatim strategy.");
    }
    const tamperChecks = [
      ["claimed_metrics", "metrics", "Metric tampering"],
      ["claimed_technologies", "technologies", "Unverified technology"],
    ] as const;
    for (const [claimKey, evidenceKey, label] of tamperChecks) {
      const values = claim[claimKey] ?? [];
      if (!Array.isArray(values)) {
        errors.push(`${claimKey} must be a list.`);
      } else {
        const evidence = evidenceKey === "metrics" ? fact.metrics : fact.technologies;
        for (const value of values) {
          if (!evidence.includes(typeof value === "string" ? value : pyString(value))) {
            errors.push(`${label} '${pyString(value)}' is not present in the cited fact.`);
          }
        }
      }
    }
    if (section === "experience") {
      const ok = validateExperienceBinding(claim, fact, profile, errors);
      return { valid: ok, errors };
    }
    return { valid: errors.length === 0, errors };
  }

  if (section === "education") {
    const fields = ["degree", "institution", "field_of_study"] as const;
    const matching = profile.education.filter((entry) =>
      fields.every((key) => {
        const value = claim[key];
        return typeof value === "string" && value !== "" && value === entry[key];
      }),
    );
    const rendered =
      `${pyString(claim["degree"])} in ${pyString(claim["field_of_study"])}, ${pyString(claim["institution"])}`;
    if (matching.length === 0 || (text ?? null) !== rendered) {
      errors.push("Claim is not in verified education.");
    }
    return { valid: errors.length === 0, errors };
  }

  errors.push(`Unsupported claim section: ${pyString(section)}.`);
  return { valid: false, errors };
}

/** Port of `ClaimValidator.validate_draft`. */
export function validateDraft(input: {
  profile: unknown;
  draft: unknown;
  variants?: unknown;
  editedPlan?: { texts: EditedPlanClaimText[] };
}): DraftValidation {
  const envelope = DraftEnvelope.parse(input);
  const errors: string[] = [];
  const variants = Array.isArray(envelope.variants) ? envelope.variants : [];
  const claims = isRecord(envelope.draft) && Array.isArray(envelope.draft["claims"])
    ? (envelope.draft["claims"] as unknown[])
    : null;
  const claimList = claims !== null && claims.length > 0 ? claims : [];
  if (claims === null || claims.length === 0) {
    errors.push("Draft must contain a nonempty claims list.");
  }
  const seen = new Set<string>();
  let count = 0;
  const referenced = new Set<string>();
  for (const rawClaim of claimList) {
    const result = validateClaim({
      profile: envelope.profile,
      claim: rawClaim,
      variants,
      ...(input.editedPlan === undefined ? {} : { editedPlan: input.editedPlan }),
    });
    errors.push(...result.errors);
    if (!isRecord(rawClaim)) {
      continue;
    }
    const cid = rawClaim["claim_id"];
    if (typeof cid !== "string" || cid === "" || seen.has(cid)) {
      errors.push("Claim IDs must be nonempty and unique.");
    } else {
      seen.add(cid);
    }
    if (result.valid) {
      count += 1;
      const ids = rawClaim["fact_ids"];
      if (Array.isArray(ids)) {
        for (const fid of ids) {
          referenced.add(typeof fid === "string" ? fid : pyString(fid));
        }
      } else if (typeof ids === "string") {
        for (const char of Array.from(ids)) {
          referenced.add(char);
        }
      }
    }
  }
  return {
    valid: errors.length === 0,
    report: {
      is_valid: errors.length === 0,
      total_claims: claimList.length,
      validated_claims: count,
      errors,
      verified_facts_referenced: [...referenced].sort(compareCodePoints),
    },
  };
}

const SubmissionEnvelope = z.object({
  profile: z.unknown(),
  analysisData: z.unknown(),
  jdSnapshot: z.unknown(),
  candidateSnapshot: z.unknown(),
});

/** Port of `ClaimValidator.validate_analysis_submission`. */
export function validateSubmission(input: {
  profile: unknown;
  analysisData: unknown;
  jdSnapshot: unknown;
  candidateSnapshot: unknown;
}): RequirementsValidation {
  const envelope = SubmissionEnvelope.parse(input);
  if (!isRecord(envelope.analysisData)) {
    return { valid: false, errors: ["Analysis submission must be a JSON object."] };
  }
  const errors: string[] = [];
  const jdSnap = isRecord(envelope.jdSnapshot) ? envelope.jdSnapshot : {};
  const candSnap = isRecord(envelope.candidateSnapshot) ? envelope.candidateSnapshot : {};
  const subJd = pyString(envelope.analysisData["jd_snapshot_id"] ?? "");
  const actualJd = pyString(jdSnap["id"] ?? "");
  if (subJd !== actualJd) {
    errors.push(`Stale or mismatched jd_snapshot_id '${subJd}'. Current snapshot is '${actualJd}'.`);
  }
  const subCand = pyString(envelope.analysisData["candidate_snapshot_id"] ?? "");
  const actualCand = pyString(candSnap["id"] ?? "");
  if (subCand !== actualCand) {
    errors.push(
      `Stale or mismatched candidate_snapshot_id '${subCand}'. Current snapshot is '${actualCand}'.`,
    );
  }
  const requirements = envelope.analysisData["requirements"];
  if (!Array.isArray(requirements) || requirements.length === 0) {
    errors.push("Analysis must contain a non-empty list of requirements.");
    return { valid: false, errors };
  }
  const cleaned = jdSnap["cleaned_text"];
  const raw = jdSnap["raw_text"];
  const jdText =
    typeof cleaned === "string" && cleaned !== ""
      ? cleaned
      : typeof raw === "string" && raw !== ""
        ? raw
        : "";
  const nested = validateRequirements({ profile: envelope.profile, requirements, jdText });
  errors.push(...nested.errors);
  return { valid: errors.length === 0, errors };
}
