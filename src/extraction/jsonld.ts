import { parse } from "node-html-parser";
import type { FieldProvenance, PartialFields } from "./types";
import { cleanText, parsePostedDate } from "./normalize";

/**
 * JobPosting JSON-LD strategy. Malformed blocks are skipped
 * individually; `@graph` containers and node arrays are searched; the
 * first `JobPosting` node wins deterministically. Salary minors follow
 * the same no-annualization rule as text parsing: only YEAR (or absent)
 * units with a valid currency produce minors.
 */

export interface JsonLdExtraction {
  found: boolean;
  fields: PartialFields;
  provenance: FieldProvenance;
  telecommute: boolean;
}

const EMPTY: JsonLdExtraction = {
  found: false,
  fields: {},
  provenance: {},
  telecommute: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeIncludes(nodeType: unknown, name: string): boolean {
  const lowered = name.toLowerCase();
  if (typeof nodeType === "string") {
    return nodeType.toLowerCase() === lowered;
  }
  if (Array.isArray(nodeType)) {
    return nodeType.some(
      (entry) => typeof entry === "string" && entry.toLowerCase() === lowered,
    );
  }
  return false;
}

function collectNodes(doc: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(doc)) {
    return doc.filter(isRecord);
  }
  if (!isRecord(doc)) {
    return [];
  }
  const graph = doc["@graph"];
  if (Array.isArray(graph)) {
    return [doc, ...graph.filter(isRecord)];
  }
  return [doc];
}

function firstString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") {
        return entry;
      }
    }
  }
  return null;
}

function addressText(address: unknown): string | null {
  const direct = firstString(address);
  if (direct !== null) {
    return direct;
  }
  const records = Array.isArray(address) ? address.filter(isRecord) : [];
  const node = isRecord(address) ? address : (records[0] ?? null);
  if (node === null) {
    return null;
  }
  const parts = [
    firstString(node["addressLocality"]),
    firstString(node["addressRegion"]),
    firstString(node["addressCountry"]),
  ]
    .map((part) => (part === null ? null : part.trim()))
    .filter((part): part is string => part !== null && part !== "");
  return parts.length === 0 ? null : parts.join(", ");
}

function locationText(jobLocation: unknown): string | null {
  const direct = firstString(jobLocation);
  if (direct !== null) {
    return direct;
  }
  const records = Array.isArray(jobLocation)
    ? jobLocation.filter(isRecord)
    : [];
  const place = isRecord(jobLocation) ? jobLocation : (records[0] ?? null);
  if (place === null) {
    return null;
  }
  return addressText(place["address"]);
}

function isTelecommute(jobLocationType: unknown): boolean {
  if (typeof jobLocationType === "string") {
    return jobLocationType.toUpperCase() === "TELECOMMUTE";
  }
  if (Array.isArray(jobLocationType)) {
    return jobLocationType.some(
      (entry) =>
        typeof entry === "string" && entry.toUpperCase() === "TELECOMMUTE",
    );
  }
  return false;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim().replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toMinor(value: number): number | null {
  if (value < 0) {
    return null;
  }
  const minor = Math.round(value * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

function stripMarkup(value: string): string {
  return parse(value).text.replace(/\s+/g, " ").trim();
}

export function extractFromJsonLd(blocks: string[]): JsonLdExtraction {
  let posting: Record<string, unknown> | null = null;
  for (const block of blocks) {
    let doc: unknown;
    try {
      doc = JSON.parse(block) as unknown;
    } catch {
      continue;
    }
    posting = collectNodes(doc).find((node) => typeIncludes(node["@type"], "JobPosting")) ?? null;
    if (posting !== null) {
      break;
    }
  }
  if (posting === null) {
    return EMPTY;
  }
  const fields: PartialFields = {};
  const provenance: FieldProvenance = {};
  const set = <K extends keyof PartialFields>(
    field: K,
    value: PartialFields[K],
    source: string,
  ): void => {
    if (value !== null && value !== undefined) {
      fields[field] = value;
      provenance[field] = source;
    }
  };

  set("title", cleanText(firstString(posting["title"]), 500), "jsonld:title");
  const org = posting["hiringOrganization"];
  set(
    "company",
    cleanText(isRecord(org) ? firstString(org["name"]) : firstString(org), 300),
    "jsonld:hiringOrganization",
  );
  set("location", cleanText(locationText(posting["jobLocation"]), 300), "jsonld:jobLocation");

  const salary = posting["baseSalary"];
  if (isRecord(salary)) {
    const rawCurrency = firstString(salary["currency"]);
    const currency =
      rawCurrency !== null && /^[A-Za-z]{3}$/.test(rawCurrency.trim())
        ? rawCurrency.trim().toUpperCase()
        : null;
    const rawValue = salary["value"];
    const unit = firstString(
      isRecord(rawValue) ? rawValue["unitText"] : salary["unitText"],
    );
    const unitUpper = unit === null ? null : unit.toUpperCase();
    const amounts: number[] = [];
    if (isRecord(rawValue)) {
      const single = asNumber(rawValue["value"]);
      const min = asNumber(rawValue["minValue"]);
      const max = asNumber(rawValue["maxValue"]);
      if (single !== null) {
        amounts.push(single);
      } else if (min !== null || max !== null) {
        if (min !== null) amounts.push(min);
        if (max !== null) amounts.push(max);
      }
    } else {
      const single = asNumber(rawValue);
      if (single !== null) {
        amounts.push(single);
      }
    }
    if (amounts.length > 0) {
      const rendered = amounts.length === 1
        ? String(amounts[0])
        : `${Math.min(...amounts)}-${Math.max(...amounts)}`;
      const unitSuffix =
        unitUpper !== null && unitUpper !== "YEAR" ? ` per ${unitUpper}` : "";
      const text = `${currency === null ? "" : `${currency} `}${rendered}${unitSuffix}`;
      set("salaryText", cleanText(text, 500), "jsonld:baseSalary");
      set("salaryCurrency", currency, "jsonld:baseSalary");
      if ((unitUpper === null || unitUpper === "YEAR") && currency !== null) {
        const minors = amounts
          .map(toMinor)
          .filter((minor): minor is number => minor !== null);
        if (minors.length === amounts.length) {
          set("salaryMinMinor", Math.min(...minors), "jsonld:baseSalary");
          set("salaryMaxMinor", Math.max(...minors), "jsonld:baseSalary");
        }
      }
    }
  }

  const rawDescription = firstString(posting["description"]);
  set(
    "descriptionText",
    rawDescription === null ? null : cleanText(stripMarkup(rawDescription)),
    "jsonld:description",
  );
  set("postedAt", parsePostedDate(firstString(posting["datePosted"])), "jsonld:datePosted");

  return {
    found: true,
    fields,
    provenance,
    telecommute: isTelecommute(posting["jobLocationType"]),
  };
}
