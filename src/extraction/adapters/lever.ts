import type { HTMLElement } from "node-html-parser";
import { cleanText, findSalaryLine, parseSalaryLine, resolveApplyUrl } from "../normalize";
import type {
  ExtractionAdapter,
  ExtractionInput,
  FieldProvenance,
  PartialFields,
  StrategyResult,
} from "../types";

/**
 * Lever adapter (lever.co posting pages). Targets the public posting DOM
 * (`.posting-headline h2`, `.posting-categories .location`,
 * `.posting-content`, `.postings-btn`); every selector is optional.
 * The company slug in the URL path is never promoted into a name.
 */

function textOf(root: HTMLElement, selector: string): string | null {
  return cleanText(root.querySelector(selector)?.text ?? null, 1000);
}

export const leverAdapter: ExtractionAdapter = {
  id: "lever",
  version: "1",
  extract(input: ExtractionInput, root: HTMLElement): StrategyResult {
    const fields: PartialFields = {};
    const provenance: FieldProvenance = {};
    const title = textOf(root, ".posting-headline h2");
    if (title !== null) {
      fields.title = title;
      provenance.title = "lever:.posting-headline h2";
    }
    const location = textOf(root, ".posting-categories .location");
    if (location !== null) {
      fields.location = location;
      provenance.location = "lever:.posting-categories .location";
    }
    const content =
      root.querySelector(".posting-content .content") ??
      root.querySelector(".posting-content");
    const description = cleanText(content?.text ?? null);
    if (description !== null) {
      fields.descriptionText = description;
      provenance.descriptionText = "lever:.posting-content";
      const salaryLine = findSalaryLine(description);
      if (salaryLine !== null) {
        const parsed = parseSalaryLine(salaryLine);
        if (parsed !== null) {
          fields.salaryText = parsed.text;
          fields.salaryCurrency = parsed.currency;
          fields.salaryMinMinor = parsed.minMinor;
          fields.salaryMaxMinor = parsed.maxMinor;
          provenance.salaryText = "lever:salary-line";
          provenance.salaryCurrency = "lever:salary-line";
          provenance.salaryMinMinor = "lever:salary-line";
          provenance.salaryMaxMinor = "lever:salary-line";
        }
      }
    }
    const applyHref =
      root.querySelector("a.postings-btn")?.getAttribute("href") ?? null;
    const applyUrl = resolveApplyUrl(applyHref, input.finalUrl);
    if (applyUrl !== null) {
      fields.applyUrl = applyUrl;
      provenance.applyUrl = "lever:a.postings-btn";
    }
    return { fields, provenance, telecommute: false };
  },
};
