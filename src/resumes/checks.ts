import { parse } from "node-html-parser";
import { RESUME_CONFIG } from "./config";
import type { ResumeViewModel } from "./viewModel";

/**
 * Content-parity and page-budget checks across resume projections (port
 * of the `compile_html_to_pdf` QA tail: page budget, minimum
 * extractable text, and per-fragment containment of the HTML body text
 * in the PDF). Extended to Markdown and DOCX: every projection must
 * carry the same claim inventory as the canonical view model.
 */

export const MIN_PDF_TEXT_CHARS = 300;

/** Oracle normalization: strip all whitespace, Unicode casefold. */
export function normalizeForComparison(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

/**
 * Body text fragments of rendered HTML (port of `BodyTextParser`:
 * stripped non-empty text nodes inside `<body>`).
 */
export function htmlBodyFragments(html: string): string[] {
  const root = parse(html);
  const body = root.querySelector("body");
  if (!body) {
    return [];
  }
  const fragments: string[] = [];
  const visit = (node: { childNodes?: unknown[]; rawText?: string; tagName?: string }): void => {
    for (const child of node.childNodes ?? []) {
      const element = child as { rawText?: string; tagName?: string; childNodes?: unknown[] };
      if (element.tagName === undefined) {
        const text = (element.rawText ?? "").trim();
        if (text !== "") {
          fragments.push(text);
        }
      } else {
        visit(element);
      }
    }
  };
  visit(body as unknown as { childNodes?: unknown[] });
  return fragments;
}

/**
 * Assert every expected fragment is contained in the projection text
 * under comparison normalization. Throws listing the first gap.
 */
export function assertProjectionContains(
  fragments: string[],
  projectionText: string,
  projectionLabel: string,
): void {
  const normalized = normalizeForComparison(projectionText);
  for (const fragment of fragments) {
    if (!normalized.includes(normalizeForComparison(fragment))) {
      throw new Error(`${projectionLabel} is missing expected resume text: ${JSON.stringify(fragment)}.`);
    }
  }
}

/** Ordered claim inventory of the view model for cross-format comparison. */
export function claimInventory(viewModel: ResumeViewModel): string[] {
  const inventory: string[] = [];
  if (viewModel.summary_copy !== "") {
    inventory.push(viewModel.summary_copy);
  }
  for (const job of [...viewModel.professional_experience, ...viewModel.earlier_career]) {
    inventory.push(`${job.company} | ${job.dates}`);
    inventory.push(`${job.role} | ${job.location}`);
    inventory.push(...job.bullets);
  }
  for (const row of viewModel.skill_rows) {
    inventory.push(`${row.label}: ${row.terms.join(", ")}`);
  }
  for (const edu of viewModel.education_rows) {
    inventory.push(edu.dates !== "" ? `${edu.detail} (${edu.dates})` : edu.detail);
  }
  return inventory;
}

/** Assert the rendered page count fits the configured budget. */
export function assertPageBudget(
  pageCount: number,
  budget: number = RESUME_CONFIG.pageBudget,
): void {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > budget) {
    throw new Error(`Rendered resume exceeds page budget: ${pageCount} pages (budget ${budget}).`);
  }
}

/** Assert the PDF carries enough extractable text to be a real resume. */
export function assertMinExtractableText(
  text: string,
  minimum: number = MIN_PDF_TEXT_CHARS,
): void {
  if (text.trim().length < minimum) {
    throw new Error("Rendered PDF contains insufficient extractable text.");
  }
}
