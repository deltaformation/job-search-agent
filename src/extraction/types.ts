import type { HTMLElement } from "node-html-parser";
import type { Arrangement } from "../domain/enums";

export { JOB_EXTRACTION_VERSION } from "../domain/extraction";

/**
 * R2-D extraction contracts. Strategies run in deterministic precedence
 * (site adapter → JobPosting JSON-LD → generic fallback) and the first
 * strategy yielding a usable result wins outright — fields are never
 * merged across strategies, so every value has one clear provenance.
 */

export interface ExtractionInput {
  /** Raw page HTML decoded as UTF-8. */
  html: string;
  /** Rendered visible text from the fetch capture. */
  text: string;
  /** Raw JSON-LD script bodies (may be malformed; skipped individually). */
  jsonLdBlocks: string[];
  finalUrl: string;
  canonicalUrl: string;
  canonicalKey: string;
  /** Legacy-compatible ATS label (`detectAtsType`) or null. */
  atsType: string | null;
}

export interface NormalizedJobFields {
  title: string | null;
  company: string | null;
  location: string | null;
  /** Always classified; UNKNOWN is the honest unknown, never a gap. */
  arrangement: Arrangement;
  salaryText: string | null;
  salaryCurrency: string | null;
  salaryMinMinor: number | null;
  salaryMaxMinor: number | null;
  descriptionText: string | null;
  postedAt: string | null;
  /** Always set: extracted apply link or the posting URL as fallback. */
  applyUrl: string | null;
}

export type PartialFields = {
  [K in keyof NormalizedJobFields]?: NormalizedJobFields[K];
};

export type FieldProvenance = Partial<Record<keyof NormalizedJobFields, string>>;

/** Fields reported in `missingFields` when null (`salary` = salaryText). */
export const GAP_FIELDS = [
  "title",
  "company",
  "location",
  "salary",
  "description",
  "postedAt",
] as const;
export type GapField = (typeof GAP_FIELDS)[number];

/** One strategy's take: sparse fields plus where each value came from. */
export interface StrategyResult {
  fields: PartialFields;
  provenance: FieldProvenance;
  /** JSON-LD `jobLocationType: TELECOMMUTE` (or equivalent) observed. */
  telecommute: boolean;
}

export interface ExtractionAdapter {
  id: string;
  version: string;
  extract(input: ExtractionInput, root: HTMLElement): StrategyResult;
}

export type ExtractionOutcome =
  | {
      ok: true;
      fields: NormalizedJobFields;
      provenance: FieldProvenance;
      adapterId: string;
      adapterVersion: string;
      confidence: number;
      missingFields: GapField[];
      contentHash: string;
    }
  | {
      ok: false;
      reason: "EXTRACTION_INCOMPLETE";
      detail: string;
      missingFields: GapField[];
    };
