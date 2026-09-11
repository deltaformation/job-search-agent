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

test("records an application through the modal", async ({ page }) => {
  await page.goto("/board");
  await page.getByRole("button", { name: /open details for e2e tailored analyst/i }).click();
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
  await page.getByRole("button", { name: /open details for e2e beta designer/i }).click();
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
  await page.getByRole("button", { name: /open details for e2e alpha engineer/i }).click();
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

test("blocks tailored drags with an approval notice", async ({ page }) => {
  await page.goto("/board");
  const handle = page.getByRole("button", { name: /drag e2e gamma tester/i });
  const tailoredColumn = page.locator('section[aria-labelledby="column-heading-TAILORED"]');
  await dragButtonTo(page, handle, tailoredColumn);
  await expect(page.getByTestId("board-notice")).toHaveText(/approved resume/i);
  const titles = await columnCardTitles(page, "NEW");
  expect(titles.some((text) => text.includes("Gamma"))).toBe(true);
});
