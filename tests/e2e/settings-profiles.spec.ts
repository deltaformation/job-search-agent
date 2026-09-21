import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * Settings profile onboarding (WO-1.2-C, gates C1–C6) against the real
 * supervisor (web + worker) and the isolated `.e2e-data` root. Tests
 * run serially in file order and build on each other's persisted
 * profiles — the persistence itself is part of what is proven (reload
 * assertions throughout). No terminal edits or direct SQL stand in
 * for user steps; the only file read is the shipped JSON example as
 * an upload source.
 *
 * NOTE: this spec needs a working browser. It is committed for CI and
 * capable machines; the authoring sandbox cannot launch any engine
 * (see the WO-1.2-C execution record), so C-browser evidence there is
 * recorded as unproven, not substituted.
 */

async function openProfileSettings(page: Page): Promise<void> {
  await page.goto("/board");
  await page.getByRole("button", { name: "Open settings and data management" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings & Data Management" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "Candidate Profile" }).click();
}

test("onboards the default profile from the shipped example (C2)", async ({ page }) => {
  await openProfileSettings(page);
  const dialog = page.getByRole("dialog", { name: "Settings & Data Management" });
  await expect(dialog.getByText("Primary Profile")).toBeVisible();
  await expect(dialog.getByText(/Setup needed/)).toBeVisible();

  // Set up the default profile in place.
  const row = dialog.locator("li", { hasText: "Primary Profile" });
  await row.getByRole("button", { name: "Set up" }).click();
  await expect(dialog.getByText("Setup needed", { exact: false }).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Load example" }).click();
  await dialog.getByRole("button", { name: "Validate & preview" }).click();
  await expect(
    dialog.getByRole("button", { name: "Review and activate master" }),
  ).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Alex Rivera" })).toBeVisible();
  await dialog.getByRole("button", { name: "Review and activate master" }).click();
  await expect(dialog.getByText(/reviewed and activated as version 1/i)).toBeVisible();
  await expect(dialog.getByText("Ready for tailoring")).toBeVisible();

  // Persistence survives reload; the default never moved.
  await page.reload();
  await openProfileSettings(page);
  const reopened = page.getByRole("dialog", { name: "Settings & Data Management" });
  await expect(reopened.getByText("Primary Profile")).toBeVisible();
  await expect(reopened.getByText("Default", { exact: true })).toBeVisible();
  await expect(reopened.getByText(/Active master v1/)).toBeVisible();
});

test("creates a secondary profile from the default and activates it (C6)", async ({
  page,
}) => {
  await openProfileSettings(page);
  const dialog = page.getByRole("dialog", { name: "Settings & Data Management" });
  await dialog.getByRole("button", { name: "Create from existing profile" }).click();
  // The source version is displayed (active v1 of the default).
  await expect(dialog.getByText(/Copying v1 \(active\)/)).toBeVisible();
  await dialog.getByLabel("Name (slug)").fill("senior-pm");
  await dialog.getByLabel("Display name").fill("Senior Product Manager");
  await dialog.getByRole("button", { name: "Create from existing" }).click();
  await expect(dialog.getByText(/created from .* as an inactive draft/i)).toBeVisible();

  // Adjust positioning, then explicitly activate — default untouched.
  const workspace = dialog.locator('[aria-label="Setup for Senior Product Manager"]');
  await expect(workspace.getByText("Master staged — activation needed")).toBeVisible();
  await workspace.getByLabel("Target titles (one per line)").first().fill("Senior PM\nStaff PM");
  await workspace.getByRole("button", { name: "Save preferences" }).click();
  await expect(dialog.getByText(/preferences for .* saved/i)).toBeVisible();
  await workspace.getByRole("button", { name: "Activate" }).click();
  await expect(workspace.getByText("Ready for tailoring")).toBeVisible();
  const defaultRow = dialog.locator("li", { hasText: "Primary Profile" });
  await expect(defaultRow.getByText("Default", { exact: true })).toBeVisible();
});

test("selects the secondary profile for tailoring; unready options link to setup (C6)", async ({
  page,
}) => {
  // Tailoring reads the DEFAULT profile (no in-flow picker): switching
  // the default is the selection mechanism. The legacy drawer's
  // per-run profile picker was removed (WO-1.3-H).
  await openProfileSettings(page);
  const dialog = page.getByRole("dialog", { name: "Settings & Data Management" });
  const seniorRow = dialog.locator("li", { hasText: "Senior Product Manager" });
  await seniorRow.getByRole("button", { name: "Set Default" }).click();
  await expect(seniorRow.getByText("Default", { exact: true })).toBeVisible();
  const primaryRow = dialog.locator("li", { hasText: "Primary Profile" });
  await expect(primaryRow.getByText("Default", { exact: true })).toHaveCount(0);

  // An empty profile explains itself and links to its exact setup.
  await dialog.getByRole("button", { name: "Start empty" }).click();
  await dialog.getByLabel("Name (slug)").fill("empty-track");
  await dialog.getByLabel("Display name").fill("Empty Track");
  await dialog.getByRole("button", { name: "Create empty profile" }).click();
  await expect(dialog.getByText(/created empty/i)).toBeVisible();
  const emptyRow = dialog.locator("li", { hasText: "Empty Track" });
  await expect(emptyRow.getByText(/Setup needed/)).toBeVisible();
  // Creating the profile auto-opens its setup workspace, so the row
  // button flips to "Close setup" (the "Set up" entry path from a
  // fresh dialog is proven by the later Empty Track tests).
  await expect(
    dialog.locator('[aria-label="Setup for Empty Track"]'),
  ).toBeVisible();
  await expect(emptyRow.getByRole("button", { name: "Close setup" })).toBeVisible();

  // The default switch persists; the primary profile is untouched.
  await page.reload();
  await openProfileSettings(page);
  const reopened = page.getByRole("dialog", { name: "Settings & Data Management" });
  const seniorAgain = reopened.locator("li", { hasText: "Senior Product Manager" });
  await expect(seniorAgain.getByText("Default", { exact: true })).toBeVisible();
  const primaryAgain = reopened.locator("li", { hasText: "Primary Profile" });
  await expect(primaryAgain.getByText(/Active master v1/)).toBeVisible();
});

test("start-empty → upload → activate with JSON/Markdown exports (C2/C6)", async ({
  page,
}) => {
  await openProfileSettings(page);
  const dialog = page.getByRole("dialog", { name: "Settings & Data Management" });
  const row = dialog.locator("li", { hasText: "Empty Track" });
  await row.getByRole("button", { name: "Set up" }).click();
  const workspace = dialog.locator('[aria-label="Setup for Empty Track"]');
  await workspace.getByRole("button", { name: "JSON upload / paste" }).click();
  await workspace.locator('input[type="file"][accept=".json,application/json"]').setInputFiles(
    "public/examples/master-resume.json",
  );
  await workspace.getByRole("button", { name: "Validate & preview" }).click();
  await expect(
    workspace.getByRole("button", { name: "Review and activate master" }),
  ).toBeVisible();
  await workspace.getByRole("button", { name: "Review and activate master" }).click();
  await expect(dialog.getByText(/reviewed and activated as version 1/i)).toBeVisible();

  // Full history preview covers every stored section.
  await workspace.getByRole("button", { name: "Preview" }).click();
  for (const section of ["Summary", "Experience", "Skills", "Languages", "Education", "Credentials"]) {
    await expect(workspace.getByRole("region", { name: section })).toBeVisible();
  }
  // The shipped example links to linkedin.com (linkedin.example is
  // only used by unit fixtures and the structured-entry test below).
  // The "LinkedIn: " label prefix scopes this to the preview line —
  // the JSON textarea still holds the same URL as pasted text.
  await expect(
    workspace.getByText(/LinkedIn: https:\/\/www\.linkedin\.com\/in\/alex-rivera-example/),
  ).toBeVisible();
  await expect(workspace.getByText(/Projection note:/)).toBeVisible();

  // Selected-version exports download and agree with the preview.
  const jsonDownload = page.waitForEvent("download");
  await workspace.getByRole("link", { name: "JSON", exact: true }).click();
  const jsonFile = await jsonDownload;
  expect(jsonFile.suggestedFilename()).toContain(".json");
  const jsonPath = await jsonFile.path();
  expect(jsonPath).not.toBeNull();
  expect(JSON.parse(readFileSync(jsonPath as string, "utf8"))).toMatchObject({
    identity: { fullName: "Alex Rivera" },
  });

  const mdDownload = page.waitForEvent("download");
  await workspace.getByRole("link", { name: "Markdown", exact: true }).click();
  const mdFile = await mdDownload;
  expect(mdFile.suggestedFilename()).toContain(".md");
  const mdPath = await mdFile.path();
  expect(mdPath).not.toBeNull();
  const markdown = readFileSync(mdPath as string, "utf8");
  for (const section of ["Summary", "Experience", "Skills", "Languages", "Education", "Credentials"]) {
    expect(markdown).toContain(`## ${section}`);
  }
});

test("invalid input highlights fields and preserves content (C3)", async ({ page }) => {
  await openProfileSettings(page);
  const dialog = page.getByRole("dialog", { name: "Settings & Data Management" });
  const row = dialog.locator("li", { hasText: "Empty Track" });
  await row.getByRole("button", { name: "Set up" }).click();
  const workspace = dialog.locator('[aria-label="Setup for Empty Track"]');
  await workspace.getByRole("button", { name: "JSON upload / paste" }).click();
  const box = workspace.getByLabel("Master JSON (paste or loaded file)");
  await box.fill('{"identity":{}}');
  await workspace.getByRole("button", { name: "Validate & preview" }).click();
  await expect(workspace.getByText(/validation issue/)).toBeVisible();
  await expect(workspace.getByText(/identity\.fullName/)).toBeVisible();
  await expect(box).toHaveValue('{"identity":{}}');
  await expect(
    workspace.getByRole("button", { name: "Review and activate master" }),
  ).toHaveCount(0);

  // Structured entry highlights its exact control and keeps the draft.
  await workspace.getByRole("button", { name: "Structured form" }).click();
  await workspace.getByRole("button", { name: "Validate & preview" }).click();
  const fullName = workspace.getByLabel("Full name");
  await expect(fullName).toHaveAttribute("aria-invalid", "true");
  await fullName.fill("Recovered Name");
  await expect(fullName).toHaveValue("Recovered Name");
});

test("structured entry covers every field and persists it (C1)", async ({ page }) => {
  await openProfileSettings(page);
  const dialog = page.getByRole("dialog", { name: "Settings & Data Management" });
  const row = dialog.locator("li", { hasText: "Empty Track" });
  await row.getByRole("button", { name: "Set up" }).click();
  const workspace = dialog.locator('[aria-label="Setup for Empty Track"]');

  // Every §2 steering field through controls.
  await workspace.getByLabel("Display name").fill("Empty Track");
  await workspace.getByLabel("Work authorization (comma-separated)").fill("CA citizen");
  await workspace.getByLabel("Remote").check();
  await workspace.getByLabel("Sponsorship required").selectOption("no");
  await workspace.getByLabel("Willing to relocate").selectOption("");
  await workspace.getByLabel("Years of experience").fill("6");
  await workspace.getByLabel("Salary min").fill("150000");
  await workspace.getByLabel("Salary target").fill("180000");
  await workspace.getByLabel("Currency").fill("CAD");
  await workspace.getByLabel("Period").selectOption("ANNUAL");
  await workspace.getByLabel("Career keywords (one per line)").fill("platform");
  await workspace.getByLabel("Profile notes").fill("E2E notes.");
  await workspace.getByLabel("Executive narrative").fill("E2E narrative.");
  await workspace.getByRole("button", { name: "Save preferences" }).click();
  await expect(dialog.getByText(/preferences for .* saved/i)).toBeVisible();

  // Structured master entry for every payload group.
  await workspace.getByLabel("Full name").fill("E2E Structured");
  await workspace.getByLabel("Email").fill("structured@example.com");
  await workspace.getByLabel("LinkedIn").fill("https://linkedin.example/structured");
  await workspace.getByRole("button", { name: "Add employment" }).click();
  await workspace.getByLabel("Company").fill("Acme");
  await workspace.getByLabel("Role", { exact: true }).fill("PM");
  await workspace.getByLabel("Start date (YYYY-MM-DD)").fill("2022-01-01");
  await workspace.getByLabel("End date (YYYY-MM-DD)").fill("2023-01-01");
  await workspace.getByRole("button", { name: "Add achievement" }).click();
  await workspace.getByLabel("Category").fill("launch");
  await workspace.getByLabel("Achievement text").fill("Shipped E2E.");
  await workspace.getByRole("button", { name: "Add skill" }).click();
  await workspace.getByLabel("Name", { exact: true }).fill("SQL");
  await workspace.getByRole("button", { name: "Add language" }).click();
  await workspace.getByLabel("Name", { exact: true }).last().fill("French");
  await workspace.getByRole("button", { name: "Add education" }).click();
  await workspace.getByLabel("Degree").fill("B.Sc.");
  await workspace.getByLabel("Institution").fill("Example University");
  await workspace.getByRole("button", { name: "Add credential" }).click();
  await workspace.getByLabel("Name", { exact: true }).last().fill("Example Cert");
  await workspace.getByRole("button", { name: "Validate & preview" }).click();
  await expect(
    workspace.getByRole("button", { name: "Review and activate master" }),
  ).toBeVisible();
  await expect(workspace.getByRole("heading", { name: "E2E Structured" })).toBeVisible();
  await workspace.getByRole("button", { name: "Review and activate master" }).click();
  await expect(dialog.getByText(/reviewed and activated as version 2/i)).toBeVisible();
});

test("keyboard-only setup and scrolling at desktop viewports (C5)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/board");
  // Keyboard-open settings from the header.
  await page.getByRole("button", { name: "Open settings and data management" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Settings & Data Management" });
  await expect(dialog).toBeVisible();
  // Arrow-key tab navigation (Radix) reaches the profile tab. Focus
  // is asserted between presses: without sequencing, a re-render can
  // drop focus and both presses land on the first tab.
  const dataTab = dialog.getByRole("tab", { name: "Data & Backup" });
  await dataTab.focus();
  await expect(dataTab).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const aiTab = dialog.getByRole("tab", { name: "AI & Models" });
  await expect(aiTab).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("tab", { name: "Candidate Profile" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // The settings panel scrolls; tab order reaches profile actions.
  const scroller = dialog.locator(".settings-scroll");
  await expect(scroller).toBeVisible();
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(dialog.getByRole("button", { name: "Start empty" }).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Start empty" }).first().focus();
  await expect(dialog.getByRole("button", { name: "Start empty" }).first()).toBeFocused();

  // 4K CSS viewport: the dialog stays usable and scrollable.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect(dialog).toBeVisible();
  await expect(scroller).toBeVisible();
  const overflow = await scroller.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
