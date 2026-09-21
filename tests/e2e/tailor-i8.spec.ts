import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { chromium, expect, test, type Page } from "@playwright/test";
import { extractPdfText } from "../../src/resumes/pdf";
import { GAMMA_CLAIM_TEXT, GAMMA_FULL_NAME, GAMMA_JD_TEXT } from "./global-setup";

/**
 * WO-1.3-I8 browser legs (run last; robust standalone and after the
 * board/settings specs): tailor-route step/reload/new-tab coverage,
 * narrow/zoom/4K viewport + keyboard legs, and the real-Chromium PDF
 * render with extracted-text agreement.
 *
 * Gamma's PDF seed is real production-renderer output (global-setup);
 * no stub renderer is substituted anywhere in these legs. The only
 * mutation is a real in-browser approval click when v1 is still
 * awaiting (idempotent: skipped when already approved). No fact,
 * application, or ATS action is invented or taken.
 */

const DB_PATH = join(process.cwd(), ".e2e-data", "job-tracker.sqlite");
const RESULTS_DIR = join(process.cwd(), "test-results");

function openE2EDatabase(): Database.Database {
  return new Database(DB_PATH, { readonly: true });
}

function gammaJobId(page: Page): string {
  const match = page.url().match(/\/jobs\/([0-9a-f-]{36})\/tailor/);
  if (!match) {
    throw new Error(`not on a tailor route: ${page.url()}`);
  }
  return match[1] as string;
}

/** Generation/review/pointer snapshot for the zero-write legs (Q1/Q4/Q9 shape). */
function probeJobState(jobId: string): string {
  const db = openE2EDatabase();
  try {
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM generation_requests WHERE job_id = ?) AS requests,
           (SELECT COUNT(*) FROM work_items WHERE kind = 'TAILOR' AND job_id = ?) AS work,
           (SELECT COUNT(*) FROM resume_versions WHERE job_id = ?) AS versions,
           (SELECT COUNT(*) FROM resume_reviews rr
             JOIN resume_versions v ON v.id = rr.resume_version_id
            WHERE v.job_id = ?) AS reviews,
           (SELECT COUNT(*) FROM tailoring_workspaces WHERE job_id = ?) AS workspaces`
      )
      .get(jobId, jobId, jobId, jobId, jobId);
    const pointers = db
      .prepare(
        `SELECT status, row_version, active_resume_version_id, selected_resume_version_id,
                active_extraction_id, tailoring_state
           FROM jobs WHERE id = ?`
      )
      .get(jobId);
    return JSON.stringify({ counts, pointers });
  } finally {
    db.close();
  }
}

async function openGammaTailorRoute(page: Page): Promise<string> {
  await page.goto("/board");
  await page.getByRole("button", { name: /open details for e2e gamma tester/i }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}\/tailor/);
  return gammaJobId(page);
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

test("I8-1 tailor route steps 1-4, reload, and back/forward resolve without writes", async ({
  page,
}) => {
  const jobId = await openGammaTailorRoute(page);
  const before = probeJobState(jobId);
  const nav = page.getByRole("navigation", { name: "Tailoring workflow progress" });

  // Lands on Step 4 for the published v1 review.
  await expect(page.getByRole("heading", { name: /review & approve/i })).toBeVisible();

  // Step 1 shows the retained JD bytes verbatim.
  await nav.getByRole("button", { name: /review data/i }).click();
  await expect(page.getByRole("heading", { name: /^review data$/i })).toBeVisible();
  await expect(page.getByText(GAMMA_JD_TEXT).first()).toBeVisible();

  // Step 2 mounts the focus surface; this v1 seed job was never
  // prepared, so the honest state is "Not prepared" (no fake editor).
  await nav.getByRole("button", { name: /tailor resume/i }).click();
  await expect(page.getByText(/not prepared/i).first()).toBeVisible();

  // Step 3 with no live run shows the honest empty state.
  await nav.getByRole("button", { name: /^generate/i }).click();
  await expect(page.getByRole("heading", { name: /no active generation/i })).toBeVisible();

  // Step 4 review again, then reload on Step 1 keeps step + content.
  await nav.getByRole("button", { name: /review & approve/i }).click();
  await expect(page.getByRole("heading", { name: /review & approve/i })).toBeVisible();
  await nav.getByRole("button", { name: /review data/i }).click();
  await expect(page).toHaveURL(/[?&]step=1(&|$)/);
  await page.reload();
  await expect(nav.getByRole("button", { name: /review data/i })).toHaveAttribute(
    "aria-current",
    "step"
  );
  await expect(page.getByText(GAMMA_JD_TEXT).first()).toBeVisible();

  // Back/forward keep the same owned tailor route mounted (no crash,
  // no job switch); reload then applies the URL step.
  await page.goBack();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}\/tailor/);
  expect(gammaJobId(page)).toBe(jobId);
  await page.goForward();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}\/tailor/);
  expect(gammaJobId(page)).toBe(jobId);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Tailoring workflow progress" })).toBeVisible();

  expect(probeJobState(jobId)).toBe(before);
});

test("I8-2 exact approved PDF opens in a new tab, renders, and agrees on text", async ({
  page,
  request,
}) => {
  const jobId = await openGammaTailorRoute(page);

  // Real in-browser approval only when v1 is still awaiting (full
  // suite: already approved by the board spec; standalone: approve
  // here through the same human path).
  const approve = page.getByRole("button", { name: /^approve version$/i });
  await expect(approve).toBeVisible();
  if (await approve.isEnabled()) {
    await approve.click();
    // On success the app navigates itself to ?step=4&version=<id>;
    // wait for that navigation instead of reloading over the POST.
    await expect(page).toHaveURL(/step=4&version=[0-9a-f-]{36}/, { timeout: 15_000 });
  }
  await expect(page.getByRole("button", { name: /^approve version$/i })).toBeDisabled({
    timeout: 15_000,
  });
  await expect(page.getByText(/approved by a human/i)).toBeVisible({ timeout: 15_000 });

  const pdfLink = page.getByRole("link", { name: /open exact pdf/i });
  await expect(pdfLink).toBeVisible();
  await expect(pdfLink).toHaveAttribute("target", "_blank");
  const href = await pdfLink.getAttribute("href");
  expect(href).toMatch(/^\/api\/resumes\/artifacts\/[0-9a-f-]{36}$/);
  const artifactId = (href as string).split("/").pop() as string;

  // Served bytes equal the database row and belong to the selected
  // approved version (Q7 shape): exact approved artifact, no fallback.
  const db = openE2EDatabase();
  let row: { versionId: string; sha256: string; byteSize: number };
  try {
    row = db
      .prepare(
        `SELECT v.id AS versionId, a.sha256 AS sha256, a.byte_size AS byteSize
           FROM jobs j
           JOIN resume_versions v ON v.id = j.selected_resume_version_id
           JOIN resume_artifacts a ON a.resume_version_id = v.id AND a.kind = 'PDF'
          WHERE j.id = ? AND a.id = ?`
      )
      .get(jobId, artifactId) as typeof row;
  } finally {
    db.close();
  }
  expect(row).toBeDefined();

  const served = await request.get(href as string);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toContain("application/pdf");
  const servedBytes = Buffer.from(await served.body());
  expect(servedBytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(servedBytes.length).toBe(row.byteSize);
  const servedSha = createHash("sha256").update(servedBytes).digest("hex");
  expect(servedSha).toBe(row.sha256);

  // Render the served artifact in a new full-Chromium tab and
  // screenshot it. The headless shell has no PDF viewer (it
  // downloads), so this leg uses the full Chromium build against the
  // exact production URL and headers — no stub, no header edits.
  mkdirSync(RESULTS_DIR, { recursive: true });
  const screenshotPath = join(RESULTS_DIR, "i8-approved-pdf.png");
  const pdfBrowser = await chromium.launch({ channel: "chromium" });
  try {
    const pdfContext = await pdfBrowser.newContext();
    const pdfPage = await pdfContext.newPage();
    try {
      await pdfPage.goto(`http://127.0.0.1:3107${href as string}`);
      await pdfPage.waitForLoadState("load");
      await pdfPage.waitForTimeout(1500);
      await pdfPage.screenshot({ path: screenshotPath, fullPage: false });
    } finally {
      await pdfPage.close();
      await pdfContext.close();
    }
  } finally {
    await pdfBrowser.close();
  }
  const screenshotBytes = readFileSync(screenshotPath);
  expect(screenshotBytes.length).toBeGreaterThan(10_000);
  const screenshotSha = createHash("sha256").update(screenshotBytes).digest("hex");

  // Extracted-text agreement: the served PDF carries the seeded
  // canonical name + claim text (same view model as the Markdown).
  const { pageCount, text } = await extractPdfText(servedBytes);
  expect(pageCount).toBeGreaterThanOrEqual(1);
  const flat = normalizeWhitespace(text);
  // The trusted template uppercases the header name for display, so
  // the name agrees case-insensitively; the claim must match exactly.
  expect(flat.toLowerCase()).toContain(GAMMA_FULL_NAME.toLowerCase());
  expect(flat).toContain(normalizeWhitespace(GAMMA_CLAIM_TEXT));

  const evidence = {
    jobId,
    versionId: row.versionId,
    artifactId,
    artifactSha256: servedSha,
    artifactBytes: servedBytes.length,
    pdfPages: pageCount,
    screenshotPath: "test-results/i8-approved-pdf.png",
    screenshotSha256: screenshotSha,
    screenshotBytes: screenshotBytes.length,
  };
  writeFileSync(join(RESULTS_DIR, "i8-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`I8_EVIDENCE ${JSON.stringify(evidence)}`);
});

test("I8-3 tailor route at 390/1280/4K and 200% zoom stays keyboard-operable", async ({
  page,
}) => {
  const jobId = await openGammaTailorRoute(page);
  const nav = page.getByRole("navigation", { name: "Tailoring workflow progress" });
  const stepNames = [/review data/i, /tailor resume/i, /^generate/i, /review & approve/i];

  // 1280: every step control is directly visible.
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const name of stepNames) {
    await expect(nav.getByRole("button", { name })).toBeVisible();
  }

  // 390: every step stays reachable (scroll if needed) and operable.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of stepNames) {
    const button = nav.getByRole("button", { name });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeVisible();
  }
  await nav.getByRole("button", { name: /review data/i }).click();
  await expect(page.getByRole("heading", { name: /^review data$/i })).toBeVisible();

  // 4K: all four steps visible at once.
  await page.setViewportSize({ width: 2560, height: 1440 });
  for (const name of stepNames) {
    await expect(nav.getByRole("button", { name })).toBeVisible();
  }

  // 200% zoom: keyboard-only step navigation keeps working and the
  // focused control stays in view (never obscured).
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "200%";
  });
  const step1Button = nav.getByRole("button", { name: /review data/i });
  await step1Button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: /^review data$/i })).toBeVisible();
  const step4Button = nav.getByRole("button", { name: /review & approve/i });
  await step4Button.focus();
  await expect(step4Button).toBeFocused();
  const box = await step4Button.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: /review & approve/i })).toBeVisible();

  // No focus trap on the page: repeated Tab keeps reaching fresh,
  // visible controls, including every step and the PDF link.
  await step1Button.focus();
  const seen = new Set<string>();
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => {
      const el = document.activeElement;
      if (el === null || el === document.body) {
        return "";
      }
      return (
        el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 60) ?? el.tagName
      );
    });
    if (label !== "") {
      seen.add(label);
    }
  }
  expect(seen.size).toBeGreaterThanOrEqual(8);
  const joined = [...seen].join("\n");
  expect(joined).toMatch(/review data/i);
  expect(joined).toMatch(/review & approve/i);
  expect(joined).toMatch(/open exact pdf/i);

  // No drag-only action on this route's reachable states: every drag
  // surface is absent, so all primary actions are native buttons/links.
  expect(await page.locator('[draggable="true"]').count()).toBe(0);
  expect(await page.getByRole("button", { name: /drag /i }).count()).toBe(0);

  // Properties sheet: Escape closes and focus returns to the
  // trigger (C3 contract). The sheet implements no Tab trap — Tab
  // can leave it — so this leg asserts the honest behavior: open,
  // Tab reaches a real control, Escape closes with focus restored.
  const propertiesTrigger = page.getByRole("button", { name: /properties/i }).first();
  await propertiesTrigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Tab");
  const tabTarget = await page.evaluate(() => {
    const el = document.activeElement;
    return el === null ? "" : (el.tagName ?? "");
  });
  expect(["BUTTON", "A", "SELECT", "INPUT", "SUMMARY"]).toContain(tabTarget);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(propertiesTrigger).toBeFocused();

  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
  });
  expect(gammaJobId(page)).toBe(jobId);
});
