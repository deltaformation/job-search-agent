import type { HTMLElement } from "node-html-parser";
import {
  cleanText,
  findSalaryLine,
  parsePostedDate,
  parseSalaryLine,
  resolveApplyUrl,
} from "./normalize";
import type {
  ExtractionInput,
  FieldProvenance,
  PartialFields,
  StrategyResult,
} from "./types";

/**
 * Generic semantic/meta fallback. Runs last and claims little: document
 * title/heading for the title, meta descriptions for the summary,
 * salary-looking lines, apply-looking links, and `<time datetime>`.
 * Company and location have no reliable generic source and stay null
 * rather than guessed.
 */

const MIN_PARAGRAPH_CHARS = 100;

function metaContent(root: HTMLElement, selector: string): string | null {
  const content = root.querySelector(selector)?.getAttribute("content");
  return cleanText(content ?? null, 2000);
}

function longestParagraph(root: HTMLElement): string | null {
  let best: string | null = null;
  for (const paragraph of root.querySelectorAll("p")) {
    const text = cleanText(paragraph.text, 100_000);
    if (
      text !== null &&
      text.length >= MIN_PARAGRAPH_CHARS &&
      (best === null || text.length > best.length)
    ) {
      best = text;
    }
  }
  return best;
}

export function extractGeneric(
  input: ExtractionInput,
  root: HTMLElement,
): StrategyResult {
  const fields: PartialFields = {};
  const provenance: FieldProvenance = {};
  const title =
    metaContent(root, 'meta[property="og:title"]') ??
    cleanText(root.querySelector("title")?.text ?? null, 500) ??
    cleanText(root.querySelector("h1")?.text ?? null, 500);
  if (title !== null) {
    fields.title = title;
    provenance.title = "generic:title";
  }
  const description =
    metaContent(root, 'meta[name="description"]') ??
    metaContent(root, 'meta[property="og:description"]') ??
    longestParagraph(root);
  if (description !== null) {
    fields.descriptionText = description;
    provenance.descriptionText = "generic:description";
  }
  const salaryLine = findSalaryLine(input.text);
  if (salaryLine !== null) {
    const parsed = parseSalaryLine(salaryLine);
    if (parsed !== null) {
      fields.salaryText = parsed.text;
      fields.salaryCurrency = parsed.currency;
      fields.salaryMinMinor = parsed.minMinor;
      fields.salaryMaxMinor = parsed.maxMinor;
      provenance.salaryText = "generic:salary-line";
      provenance.salaryCurrency = "generic:salary-line";
      provenance.salaryMinMinor = "generic:salary-line";
      provenance.salaryMaxMinor = "generic:salary-line";
    }
  }
  const applyAnchor = root
    .querySelectorAll("a")
    .find(
      (anchor) =>
        /apply/i.test(anchor.getAttribute("href") ?? "") ||
        /apply/i.test(anchor.text ?? ""),
    );
  const applyUrl = resolveApplyUrl(
    applyAnchor?.getAttribute("href") ?? null,
    input.finalUrl,
  );
  if (applyUrl !== null) {
    fields.applyUrl = applyUrl;
    provenance.applyUrl = "generic:apply-anchor";
  }
  const postedAt = parsePostedDate(
    root.querySelector("time")?.getAttribute("datetime") ?? null,
  );
  if (postedAt !== null) {
    fields.postedAt = postedAt;
    provenance.postedAt = "generic:time";
  }
  return { fields, provenance, telecommute: false };
}
