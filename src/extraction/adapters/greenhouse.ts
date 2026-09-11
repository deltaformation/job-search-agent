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
 * Greenhouse adapter (boards.greenhouse.io posting pages). Targets the
 * public posting DOM (`h1.app-title`, `.location`, `#app-body`,
 * `#apply_button`); every selector is optional and a missing one simply
 * leaves its field null. Company name has no reliable posting-DOM
 * source — the board token in the URL is a slug, not a name, so it is
 * never promoted into one.
 */

function textOf(root: HTMLElement, selector: string): string | null {
  return cleanText(root.querySelector(selector)?.text ?? null, 1000);
}

export const greenhouseAdapter: ExtractionAdapter = {
  id: "greenhouse",
  version: "1",
  extract(input: ExtractionInput, root: HTMLElement): StrategyResult {
    const fields: PartialFields = {};
    const provenance: FieldProvenance = {};
    const title = textOf(root, "h1.app-title");
    if (title !== null) {
      fields.title = title;
      provenance.title = "greenhouse:h1.app-title";
    }
    const location = textOf(root, ".location");
    if (location !== null) {
      fields.location = location;
      provenance.location = "greenhouse:.location";
    }
    const body =
      root.querySelector("#app-body") ?? root.querySelector("#content");
    const description = cleanText(body?.text ?? null);
    if (description !== null) {
      fields.descriptionText = description;
      provenance.descriptionText = "greenhouse:#app-body";
      const salaryLine = findSalaryLine(description);
      if (salaryLine !== null) {
        const parsed = parseSalaryLine(salaryLine);
        if (parsed !== null) {
          fields.salaryText = parsed.text;
          fields.salaryCurrency = parsed.currency;
          fields.salaryMinMinor = parsed.minMinor;
          fields.salaryMaxMinor = parsed.maxMinor;
          provenance.salaryText = "greenhouse:salary-line";
          provenance.salaryCurrency = "greenhouse:salary-line";
          provenance.salaryMinMinor = "greenhouse:salary-line";
          provenance.salaryMaxMinor = "greenhouse:salary-line";
        }
      }
    }
    const applyHref =
      root.querySelector("#apply_button")?.getAttribute("href") ?? null;
    const applyUrl = resolveApplyUrl(applyHref, input.finalUrl);
    if (applyUrl !== null) {
      fields.applyUrl = applyUrl;
      provenance.applyUrl = "greenhouse:#apply_button";
    }
    return { fields, provenance, telecommute: false };
  },
};
