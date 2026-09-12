// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  assertMinExtractableText,
  assertPageBudget,
  assertProjectionContains,
  htmlBodyFragments,
} from "../../../../src/resumes/checks";
import { extractPdfText, renderPdf } from "../../../../src/resumes/pdf";
import { renderHtml } from "../../../../src/resumes/template";
import { buildViewModel, type ResumeViewModel } from "../../../../src/resumes/viewModel";

/**
 * Real-Chromium PDF tests: HTML → PDF via page.pdf, then page-budget,
 * minimum-text, and fragment-containment checks. No network is touched
 * (the renderer aborts every request).
 *
 * These tests need a working Chromium launch. They fail in sandboxed
 * sessions where the OS denies browser startup (headless-shell SIGSEGV);
 * run them on a normal machine or CI.
 */
const BROWSER_TIMEOUT = 60_000;

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, BROWSER_TIMEOUT);

afterAll(async () => {
  await browser?.close();
});

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

describe("Chromium PDF rendering", () => {
  it("renders one page with extractable resume text", async () => {
    const html = renderHtml(fixtureModel());
    const { bytes } = await renderPdf(html, browser);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const { pageCount, text } = await extractPdfText(bytes);
    expect(pageCount).toBe(1);
    assertPageBudget(pageCount);
    assertMinExtractableText(text);
  });

  it("keeps every HTML body fragment in the PDF text", async () => {
    const html = renderHtml(fixtureModel());
    const { bytes } = await renderPdf(html, browser);
    const { text } = await extractPdfText(bytes);
    const fragments = htmlBodyFragments(html);
    expect(fragments.length).toBeGreaterThan(0);
    assertProjectionContains(fragments, text, "PDF");
  });

  it("renders hostile text inert and contained", async () => {
    const model = buildViewModel({
      profile: {
        full_name: "<img src=x onerror=alert(1)>",
        work_experience: [
          { id: "e1", company: "Acme", role: "PM", start_date: "2020-01-01", is_current: true },
        ],
        verified_facts: [],
        skills: [],
        education: [],
      },
      draft: {
        claims: [{ section: "experience", entity_id: "e1", text: "Did <b>things</b> & stuff." }],
      },
    });
    const html = renderHtml(model);
    const { bytes } = await renderPdf(html, browser);
    const { pageCount, text } = await extractPdfText(bytes);
    assertPageBudget(pageCount);
    expect(text).toContain("Did <b>things</b>");
  });
});
