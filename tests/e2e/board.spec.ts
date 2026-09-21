import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Board flows against the seeded database (global-setup): three NEW cards
 * and one TAILORED card. Tests run serially in file order and build on
 * each other's persisted moves — the persistence itself is part of what is
 * proven (reload assertions throughout).
 *
 * Drag mechanics note: dnd-kit swallows the activation move (the one that
 * exceeds the pointer distance constraint starts the drag but never updates
 * its coordinates), so a single-jump hover-then-drop resolves `over` to the
 * dragged card itself and the app correctly no-ops. Pointer drags below
 * therefore glide in steps; the keyboard drag presses ArrowUp until the
 * live region reports another card. Outcome assertions target the app
 * notice (data-testid), never the shared role=status — dnd-kit owns a
 * second live region with that role.
 */

async function columnCardTitles(page: Page, status: string): Promise<string[]> {
  const locator = page.locator(`section[aria-labelledby="column-heading-${status}"] li`);
  await locator.first().waitFor({ state: "visible", timeout: 10000 });
  return locator.allInnerTexts();
}

function center(box: { x: number; y: number; width: number; height: number }): {
  x: number;
  y: number;
} {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Pointer drag that survives dnd-kit activation: measure first, then glide. */
async function dragButtonTo(page: Page, handle: Locator, target: Locator): Promise<void> {
  await handle.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const fromBox = await handle.boundingBox();
  const toBox = await target.boundingBox();
  if (fromBox === null || toBox === null) {
    throw new Error("drag endpoints must be visible");
  }
  const from = center(fromBox);
  const to = center(toBox);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 15 });
  await page.mouse.up();
}

test("keeps five columns navigable at desktop, mobile, and 4K widths", async ({ page }) => {
  await page.goto("/board");
  const canvas = page.getByRole("group", { name: "Kanban columns" });
  // 1280: the focus columns stay readable.
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const name of [/new \(\d+ of \d+\)/i, /tailored \(\d+ of \d+\)/i, /applied \(\d+ of \d+\)/i]) {
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
  // 390: the canvas scrolls horizontally and every column stays reachable.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: /new \(\d+ of \d+\)/i })).toBeVisible();
  expect(await canvas.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  const rejected = page.getByRole("heading", { name: /rejected \(\d+ of \d+\)/i });
  await rejected.scrollIntoViewIfNeeded();
  await expect(rejected).toBeVisible();
  // 4K: all five columns visible at once.
  await page.setViewportSize({ width: 2560, height: 1440 });
  for (const status of ["New", "Tailored", "Applied", "Interviewed", "Rejected"]) {
    await expect(
      page.getByRole("heading", { name: new RegExp(`${status} \\(\\d+ of \\d+\\)`, "i") }),
    ).toBeVisible();
  }
});

test("shows five columns with seeded cards", async ({ page }) => {
  await page.goto("/board");
  for (const heading of ["New (3 of 3)", "Tailored (1 of 1)", "Applied (0 of 0)"]) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: /open details for e2e alpha engineer/i })).toBeVisible();
});

test("reorders by pointer drag and persists", async ({ page }) => {
  await page.goto("/board");
  const handle = page.getByRole("button", { name: /drag e2e beta designer/i });
  const target = page.getByRole("button", { name: /open details for e2e alpha engineer/i });
  await dragButtonTo(page, handle, target);
  await expect(page.getByTestId("board-notice")).toHaveText(/card reordered/i);
  const titles = await columnCardTitles(page, "NEW");
  expect(titles.findIndex((text) => text.includes("Beta"))).toBeLessThan(
    titles.findIndex((text) => text.includes("Alpha")),
  );
  await page.reload();
  const reloaded = await columnCardTitles(page, "NEW");
  expect(reloaded.findIndex((text) => text.includes("Beta"))).toBeLessThan(
    reloaded.findIndex((text) => text.includes("Alpha")),
  );
});

test("reorders by keyboard and persists", async ({ page }) => {
  await page.goto("/board");
  // Alpha sits second after the pointer-drag test; lift it back above Beta.
  // One ArrowUp moves 25px and stays over the card itself, so keep pressing
  // until the live region reports another card (bounded; the order
  // assertions below fail loudly if the drop never leaves the card).
  const liveRegion = page.locator('div[role="status"]');
  await page.getByRole("button", { name: /drag e2e alpha engineer/i }).focus();
  await page.keyboard.press("Space");
  for (let presses = 0; presses < 10; presses += 1) {
    const text = await liveRegion.textContent();
    if (text !== null && /over another card/i.test(text)) {
      break;
    }
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(60);
  }
  await page.keyboard.press("Space");
  await expect(page.getByTestId("board-notice")).toHaveText(/card reordered/i);
  const titles = await columnCardTitles(page, "NEW");
  expect(titles.findIndex((text) => text.includes("Alpha"))).toBeLessThan(
    titles.findIndex((text) => text.includes("Beta")),
  );
  await page.reload();
  const reloaded = await columnCardTitles(page, "NEW");
  expect(reloaded.findIndex((text) => text.includes("Alpha"))).toBeLessThan(
    reloaded.findIndex((text) => text.includes("Beta")),
  );
});

// Non-mutating guard check placed before the application test moves the
// analyst out: dropping onto an occupied column is the stable geometry
// (empty-column drops proved unreliable — see dragButtonTo note).
test("blocks tailored drags with an approval notice", async ({ page }) => {
  await page.goto("/board");
  const handle = page.getByRole("button", { name: /drag e2e gamma tester/i });
  const tailoredColumn = page.locator('section[aria-labelledby="column-heading-TAILORED"]');
  // The droppable is the column's card container, not the section: with
  // cards present drop onto one, otherwise onto the empty drop zone —
  // the section center can land on the non-droppable header.
  const cards = tailoredColumn.locator("li");
  const target =
    (await cards.count()) > 0
      ? cards.first()
      : tailoredColumn.getByText("No cards. Drop here to move one in.");
  await dragButtonTo(page, handle, target);
  await expect(page.getByTestId("board-notice")).toHaveText(/approved resume/i);
  const titles = await columnCardTitles(page, "NEW");
  expect(titles.some((text) => text.includes("Gamma"))).toBe(true);
});

test("records an application through the modal", async ({ page }) => {
  await page.goto("/board");
  await page.getByRole("button", { name: /open properties for e2e tailored analyst/i }).click();
  await page.getByLabel("Move to").selectOption("APPLIED");
  await page.getByRole("button", { name: /^move$/i }).click();
  await page.getByLabel(/confirmation number/i).fill("E2E-1");
  await page.getByRole("button", { name: /record application/i }).click();
  await expect(page.getByRole("heading", { name: /applied \(1 of 1\)/i })).toBeVisible();
  await expect(
    page.locator('section[aria-labelledby="column-heading-APPLIED"] li').getByText("E2E Tailored Analyst"),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: /applied \(1 of 1\)/i })).toBeVisible();
});

test("rejects with a reason through the dialog", async ({ page }) => {
  await page.goto("/board");
  await page.getByRole("button", { name: /open properties for e2e beta designer/i }).click();
  await page.getByLabel("Move to").selectOption("REJECTED");
  await page.getByRole("button", { name: /^move$/i }).click();
  await page.getByLabel(/reason \(required\)/i).fill("duplicate posting");
  await page.getByRole("button", { name: /^reject card$/i }).click();
  await expect(page.getByRole("heading", { name: /rejected \(1 of 1\)/i })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: /rejected \(1 of 1\)/i })).toBeVisible();
});

test("corrects with a note and appends notes in the drawer", async ({ page }) => {
  await page.goto("/board");
  await page.getByRole("button", { name: /open properties for e2e alpha engineer/i }).click();
  await page.getByRole("button", { name: /correct \/ reopen/i }).click();
  const modal = page.getByRole("dialog").filter({ hasText: "Save correction" });
  await modal.getByLabel("Move to").selectOption("INTERVIEWED");
  await modal.getByLabel(/note \(required\)/i).fill("skipped straight to onsite");
  await modal.getByRole("button", { name: /save correction/i }).click();
  const dialog = page.getByRole("dialog");
  // The drawer renders "Status: INTERVIEWED · …" — match the visible line,
  // never an exact token (exact matches only the hidden select options).
  await expect(dialog.getByText(/Status:\s*INTERVIEWED/).first()).toBeVisible();
  await expect(dialog.getByText(/skipped straight to onsite/).first()).toBeVisible();
  await page.getByLabel("Add a note").fill("second note");
  await page.getByRole("button", { name: /^add note$/i }).click();
  await expect(dialog.getByRole("heading", { name: /notes \(2\)/i })).toBeVisible();
});

test("reviews the exact version on the tailor route, approves to TAILORED, and moves to APPLIED", async ({ page }) => {
  await page.goto("/board");
  // Gamma sits in NEW with an AWAITING_REVIEW resume.
  // H1: the legacy drawer offers entry links, not embedded review.
  await page.getByRole("button", { name: /open properties for e2e gamma tester/i }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByRole("tab", { name: /tailoring & resumes/i }).click();
  await expect(drawer.getByText("Version 1")).toBeVisible();
  const reviewLink = drawer.getByRole("link", { name: /review version 1 in the tailor flow/i });
  await expect(reviewLink).toHaveAttribute("href", /\/tailor\?step=4&version=[0-9a-f-]{36}/);
  await drawer.getByRole("button", { name: /^close$/i }).click();

  // Open details navigates straight to the tailor route (C1), which
  // lands on Step 4 for the awaiting version — then single-gesture
  // approval.
  await page.getByRole("button", { name: /open details for e2e gamma tester/i }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}\/tailor/);
  await expect(page.getByRole("region", { name: /step 4 of 4/i })).toBeVisible();
  const approve = page.getByRole("button", { name: /^approve version$/i });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(approve).toBeDisabled();

  // Gamma should now be in TAILORED column
  await page.goto("/board");
  await expect(page.getByRole("heading", { name: /tailored \(1 of 1\)/i })).toBeVisible();
  await expect(
    page.locator('section[aria-labelledby="column-heading-TAILORED"] li').getByText("E2E Gamma Tester"),
  ).toBeVisible();

  // Record application on Gamma
  await page.getByRole("button", { name: /open properties for e2e gamma tester/i }).click();
  await page.getByLabel("Move to").selectOption("APPLIED");
  await page.getByRole("button", { name: /^move$/i }).click();
  await page.getByLabel(/confirmation number/i).fill("CONF-GAMMA-777");
  await page.getByRole("button", { name: /record application/i }).click();

  // Total applied is now 2 (Tailored Analyst from test 4 + Gamma Tester)
  await expect(page.getByRole("heading", { name: /applied \(2 of 2\)/i })).toBeVisible();
});

test("submits URL intake, previews validation, and tracks batch progress", async ({ page }) => {
  await page.goto("/intake");
  await expect(page.getByRole("heading", { name: /add job urls/i })).toBeVisible();

  // Paste a valid URL and an invalid URL
  await page.getByLabel(/one per line/i).fill("https://example.com/jobs/intake-smoke\nnot-a-valid-url");

  // Click Validate
  await page.getByRole("button", { name: /validate/i }).click();

  // Expect validation preview table
  await expect(page.getByText("Validation preview")).toBeVisible();
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await expect(page.getByText("Invalid", { exact: true })).toBeVisible();
  await expect(page.getByText(/not a parseable absolute URL/i)).toBeVisible();

  // Queue batch
  await page.getByRole("button", { name: /queue batch/i }).click();

  // Should navigate to /intake/batches/:id
  await expect(page).toHaveURL(/\/intake\/batches\/[0-9a-f-]+/);
  await expect(page.getByText(/batch progress/i)).toBeVisible();
  await expect(page.getByText(/1 queued, 0 duplicate, 1 invalid, 0 blocked, of 2 pasted lines/i)).toBeVisible();
});

