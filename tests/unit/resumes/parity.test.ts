// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertProjectionContains,
  claimInventory,
  htmlBodyFragments,
  normalizeForComparison,
} from "../../../src/resumes/checks";
import { extractDocxParagraphs, loadDocxTemplateBytes, renderDocx } from "../../../src/resumes/docx";
import { renderMarkdown } from "../../../src/resumes/markdown";
import { renderHtml } from "../../../src/resumes/template";
import {
  buildViewModel,
  renderPlainText,
  type ResumeViewModel,
} from "../../../src/resumes/viewModel";

/**
 * Cross-format content parity: every projection of the canonical view
 * model carries the same claim inventory. (PDF joins this comparison in
 * the browser suite, where Chromium renders it.)
 */
function fixtureModel(): ResumeViewModel {
  const suite = JSON.parse(
    readFileSync(join(process.cwd(), "tests", "fixtures", "parity", "view-model.json"), "utf8"),
  ) as { cases: Array<{ id: string; input: { profile: unknown; draft: unknown } }> };
  const ordering = suite.cases.find((entry) => entry.id === "vm-ordering");
  if (!ordering) {
    throw new Error("vm-ordering fixture case missing");
  }
  return buildViewModel({ profile: ordering.input.profile, draft: ordering.input.draft });
}

describe("cross-format content parity", () => {
  it("covers the full claim inventory in Markdown, DOCX, and plain text", () => {
    const model = fixtureModel();
    const inventory = claimInventory(model);
    expect(inventory.length).toBeGreaterThan(0);
    // Markdown emphasis markers are presentation, not content.
    const markdown = renderMarkdown(model).replace(/[*#]/g, "");
    const docxText = extractDocxParagraphs(
      renderDocx(model, loadDocxTemplateBytes()),
    ).join("\n");
    const plain = renderPlainText(model);
    for (const entry of inventory) {
      const normalized = normalizeForComparison(entry);
      expect(normalized.length).toBeGreaterThan(0);
      expect(normalizeForComparison(markdown)).toContain(normalized);
      expect(normalizeForComparison(docxText)).toContain(normalized);
      expect(normalizeForComparison(plain)).toContain(normalized);
    }
  });

  it("keeps every HTML body fragment in the Markdown and DOCX projections", () => {
    const model = fixtureModel();
    const fragments = htmlBodyFragments(renderHtml(model));
    expect(fragments.length).toBeGreaterThan(0);
    const markdown = renderMarkdown(model).replace(/[*#]/g, "");
    const docxText = extractDocxParagraphs(
      renderDocx(model, loadDocxTemplateBytes()),
    ).join("\n");
    assertProjectionContains(fragments, markdown, "Markdown");
    assertProjectionContains(fragments, docxText, "DOCX");
  });

  it("keeps contact details identical across projections", () => {
    const model = fixtureModel();
    const contacts = model.header.contact_parts.map((part) => part.text);
    expect(contacts.length).toBeGreaterThan(0);
    const markdown = renderMarkdown(model);
    const docxText = extractDocxParagraphs(
      renderDocx(model, loadDocxTemplateBytes()),
    ).join("\n");
    const plain = renderPlainText(model);
    for (const contact of contacts) {
      expect(markdown).toContain(contact);
      expect(docxText).toContain(contact);
      expect(plain).toContain(contact);
    }
  });
});
