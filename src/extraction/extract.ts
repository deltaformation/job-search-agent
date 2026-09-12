import { parse } from "node-html-parser";
import { getSiteAdapter } from "./adapters/index";
import { extractGeneric } from "./generic";
import { extractFromJsonLd } from "./jsonld";
import {
  classifyArrangement,
  findSalaryLine,
  generateContentHash,
  parseSalaryLine,
} from "./normalize";
import {
  GAP_FIELDS,
  type ExtractionInput,
  type ExtractionOutcome,
  type FieldProvenance,
  type GapField,
  type NormalizedJobFields,
  type StrategyResult,
} from "./types";

/**
 * Extraction orchestrator. Strategies run in fixed precedence — site
 * adapter, then JobPosting JSON-LD, then the generic fallback — and the
 * first strategy with a usable result (a title or a description) wins
 * outright. Fields never merge across strategies, so provenance stays
 * exact. The JSON-LD telecommute signal is the one cross-strategy read:
 * arrangement classification always honors it.
 *
 * The salary backfill below is not a merge: when the winner left salary
 * empty, the winner's own description text is scanned for a salary line
 * the winner's parser missed (provenance `fallback:description-salary-line`).
 *
 * Confidence is deterministic: a per-strategy base plus coverage bonus,
 * capped below 1 because heuristics are never certain.
 */

const STRATEGY_BASE_CONFIDENCE: Readonly<Record<string, number>> = {
  adapter: 0.85,
  jsonld: 0.9,
  generic: 0.6,
};

const GENERIC_VERSION = "1";
const JSONLD_VERSION = "1";

function isUsable(result: StrategyResult): boolean {
  return result.fields.title != null || result.fields.descriptionText != null;
}

function gapFields(fields: {
  title: string | null;
  company: string | null;
  location: string | null;
  salaryText: string | null;
  descriptionText: string | null;
  postedAt: string | null;
}): GapField[] {
  const gaps: GapField[] = [];
  if (fields.title === null) gaps.push("title");
  if (fields.company === null) gaps.push("company");
  if (fields.location === null) gaps.push("location");
  if (fields.salaryText === null) gaps.push("salary");
  if (fields.descriptionText === null) gaps.push("description");
  if (fields.postedAt === null) gaps.push("postedAt");
  return gaps;
}

export function runExtraction(input: ExtractionInput): ExtractionOutcome {
  const root = parse(input.html);
  const adapter = getSiteAdapter(input.atsType);
  const adapterResult = adapter?.extract(input, root) ?? null;
  const jsonLd = extractFromJsonLd(input.jsonLdBlocks);
  const generic = (): StrategyResult => extractGeneric(input, root);

  const tried: string[] = [];
  let winner: StrategyResult | null = null;
  let winnerId = "";
  let winnerVersion = "";
  let base = 0;
  if (adapter !== null && adapterResult !== null) {
    tried.push(adapter.id);
    if (isUsable(adapterResult)) {
      winner = adapterResult;
      winnerId = adapter.id;
      winnerVersion = adapter.version;
      base = STRATEGY_BASE_CONFIDENCE["adapter"] ?? 0.85;
    }
  }
  if (winner === null && jsonLd.found) {
    tried.push("jsonld");
    if (isUsable(jsonLd)) {
      winner = jsonLd;
      winnerId = "jsonld";
      winnerVersion = JSONLD_VERSION;
      base = STRATEGY_BASE_CONFIDENCE["jsonld"] ?? 0.9;
    }
  }
  if (winner === null) {
    tried.push("generic");
    const fallback = generic();
    if (isUsable(fallback)) {
      winner = fallback;
      winnerId = "generic";
      winnerVersion = GENERIC_VERSION;
      base = STRATEGY_BASE_CONFIDENCE["generic"] ?? 0.6;
    }
  }
  if (winner === null) {
    return {
      ok: false,
      reason: "EXTRACTION_INCOMPLETE",
      detail: `no strategy (${tried.join(", ")}) found a title or description`,
      missingFields: [...GAP_FIELDS],
    };
  }

  const provenance: FieldProvenance = { ...winner.provenance };
  const applyUrl = winner.fields.applyUrl ?? input.finalUrl;
  if (winner.fields.applyUrl === undefined) {
    provenance.applyUrl = "fallback:final-url";
  }
  // Step-1 salary fallback: the winner's structured parsers (e.g.
  // JSON-LD baseSalary) miss salary lines buried in prose. Scan the
  // winner's own description text before reporting a salary gap. Hourly
  // and unrecognized lines keep verbatim text with null minors — the
  // parser never annualizes or invents amounts.
  let salaryText = winner.fields.salaryText ?? null;
  let salaryCurrency = winner.fields.salaryCurrency ?? null;
  let salaryMinMinor = winner.fields.salaryMinMinor ?? null;
  let salaryMaxMinor = winner.fields.salaryMaxMinor ?? null;
  const descriptionText = winner.fields.descriptionText ?? null;
  if (salaryText === null && descriptionText !== null) {
    const line = findSalaryLine(descriptionText);
    const parsed = line === null ? null : parseSalaryLine(line);
    if (parsed !== null) {
      salaryText = parsed.text;
      salaryCurrency = parsed.currency;
      salaryMinMinor = parsed.minMinor;
      salaryMaxMinor = parsed.maxMinor;
      provenance.salaryText = "fallback:description-salary-line";
      provenance.salaryCurrency = "fallback:description-salary-line";
      provenance.salaryMinMinor = "fallback:description-salary-line";
      provenance.salaryMaxMinor = "fallback:description-salary-line";
    }
  }
  const fields: NormalizedJobFields = {
    title: winner.fields.title ?? null,
    company: winner.fields.company ?? null,
    location: winner.fields.location ?? null,
    arrangement: classifyArrangement(
      winner.fields.location ?? null,
      jsonLd.telecommute,
    ),
    salaryText,
    salaryCurrency,
    salaryMinMinor,
    salaryMaxMinor,
    descriptionText,
    postedAt: winner.fields.postedAt ?? null,
    applyUrl,
  };
  const missingFields = gapFields(fields);
  const presentCount =
    (fields.title !== null ? 1 : 0) +
    (fields.company !== null ? 1 : 0) +
    (fields.location !== null ? 1 : 0) +
    (fields.salaryText !== null ? 1 : 0) +
    (fields.descriptionText !== null ? 1 : 0) +
    (fields.postedAt !== null ? 1 : 0) +
    (winner.fields.applyUrl !== undefined ? 1 : 0);
  const confidence =
    Math.round(Math.min(0.95, base + 0.05 * Math.max(0, presentCount - 2)) * 100) /
    100;
  return {
    ok: true,
    fields,
    provenance,
    adapterId: winnerId,
    adapterVersion: winnerVersion,
    confidence,
    missingFields,
    contentHash: generateContentHash(
      fields.company ?? "",
      fields.title ?? "",
      fields.descriptionText ?? "",
    ),
  };
}
