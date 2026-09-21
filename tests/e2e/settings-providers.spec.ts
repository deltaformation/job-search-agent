import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

/**
 * Provider configuration (WO-1.2-G, gates G1–G6 UI legs) against the real
 * supervisor (web + worker) and the isolated `.e2e-data` root. Settings
 * writes go to the isolated `test.env.local` (see playwright.config.ts),
 * never the developer's real file. No live credentials are used: key
 * round-trips use synthetic values asserted by fingerprint, and the
 * draft-model test intercepts the diagnostics call so no ambient key or
 * network can make it nondeterministic. Worker activation and guided
 * generations are proven by the isolated G checkpoint script, not here.
 *
 * NOTE: this spec needs a working browser. It is committed for CI and
 * capable machines; the authoring sandbox cannot launch any engine
 * (see the WO-1.2-G execution record), so G-browser evidence there is
 * recorded as unproven, not substituted.
 */

const SYNTHETIC_KEY = "e2e-synthetic-openrouter-key";
const SYNTHETIC_FINGERPRINT = createHash("sha256").update(SYNTHETIC_KEY, "utf8").digest("hex").slice(0, 8);

async function openAiSettings(page: Page) {
  await page.goto("/board");
  await page.getByRole("button", { name: "Open settings and data management" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings & Data Management" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "AI & Models" }).click();
  return dialog;
}

test("labels key presence Configured and shows worker state (G4)", async ({ page }) => {
  const dialog = await openAiSettings(page);
  // Key presence is "Configured", never "Connected".
  await expect(dialog.getByText("Connected", { exact: true })).toHaveCount(0);
  const cards = dialog.getByRole("radiogroup", { name: "Selected AI provider draft" });
  await expect(cards).toBeVisible();
  // Exactly one provider carries the Active badge; worker line is present.
  await expect(dialog.getByText("Active", { exact: true })).toHaveCount(1);
  await expect(dialog.getByText(/Worker:/)).toBeVisible();
});

test("saving OpenRouter preserves the selection and explains restart (G4)", async ({ page }) => {
  const dialog = await openAiSettings(page);
  await dialog.getByRole("radio", { name: /OpenRouter/ }).click();
  await dialog.getByLabel("Primary model").fill("e2e/draft-primary");
  await dialog.getByLabel("Fallback model").fill("e2e/draft-fallback");
  await dialog.getByRole("button", { name: "Save Models" }).click();
  await expect(dialog.getByText(/OpenRouter saved.*restart/i)).toBeVisible();
  // The reported regression: the form must NOT revert to Google.
  await expect(dialog.getByRole("radio", { name: /OpenRouter/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(dialog.getByLabel("Primary model")).toHaveValue("e2e/draft-primary");
  const banner = dialog.getByRole("note", { name: "Restart required" });
  await expect(banner).toContainText("OpenRouter saved — restart required");
  await expect(banner).toContainText("npm run dev");

  // The saved selection survives close and reopen.
  await page.keyboard.press("Escape");
  const reopened = await openAiSettings(page);
  await expect(reopened.getByRole("radio", { name: /OpenRouter/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // Auto-waiting: the field renders the code default until the
  // snapshot refetch lands after reopen.
  await expect(reopened.getByLabel("Primary model")).toHaveValue("e2e/draft-primary");
});

test("round-trips a key write-only: save, blank-retain, explicit remove (G3)", async ({
  page,
}) => {
  // The radio reflects the RUNNING process env (saves apply on restart),
  // so exact round-trip proof reads the save/remove RESPONSES (file
  // truth), captured pass-through — never the env-dependent radio.
  const responses: Array<Record<string, unknown>> = [];
  await page.route("/api/settings/keys", async (route) => {
    const response = await route.fetch();
    responses.push((await response.json()) as Record<string, unknown>);
    await route.fulfill({ response });
  });
  try {
    const dialog = await openAiSettings(page);
    await dialog.getByRole("radio", { name: /OpenRouter/ }).click();
    const keyField = dialog.getByLabel(/API key for OpenRouter/);
    await keyField.fill(SYNTHETIC_KEY);
    await dialog.getByRole("button", { name: "Save Key" }).click();
    await expect(dialog.getByText(/key saved/i)).toBeVisible();
    expect(responses[responses.length - 1]).toMatchObject({
      configured: true,
      fingerprint: SYNTHETIC_FINGERPRINT,
      changed: true,
    });
    // The key value itself is never displayed back.
    await expect(dialog.getByText(SYNTHETIC_KEY)).toHaveCount(0);

    // Blank save retains the stored key.
    await dialog.getByRole("button", { name: "Save Key" }).click();
    await expect(dialog.getByText(/retained/i)).toBeVisible();
    expect(responses[responses.length - 1]).toMatchObject({
      configured: true,
      fingerprint: SYNTHETIC_FINGERPRINT,
      changed: false,
    });

    // Removal needs an explicit second click, then the key is gone.
    await dialog.getByRole("button", { name: "Remove Key" }).click();
    await dialog.getByRole("button", { name: "Confirm Remove" }).click();
    await expect(dialog.getByText(/key removed/i)).toBeVisible();
    expect(responses[responses.length - 1]).toMatchObject({
      configured: false,
      fingerprint: null,
      changed: true,
    });
  } finally {
    await page.unroute("/api/settings/keys");
  }
});

test("sends the exact draft model and transient key to the test (G1)", async ({ page }) => {
  let posted: Record<string, unknown> | null = null;
  await page.route("/api/settings/ai-test", async (route) => {
    posted = (await route.request().postDataJSON()) as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        model: null,
        latencyMs: 0,
        error: "OPENROUTER_API_KEY is not configured.",
        provider: "openrouter",
        testedModel: "e2e/entered-draft",
        keySource: "transient",
        reasonCode: "missing-key",
        action: "Enter a key.",
        fallback: null,
      }),
    });
  });
  const dialog = await openAiSettings(page);
  await dialog.getByRole("radio", { name: /OpenRouter/ }).click();
  await dialog.getByLabel("Primary model").fill("e2e/entered-draft");
  await dialog.getByLabel(/API key for OpenRouter/).fill("e2e-transient-key");
  await dialog.getByRole("button", { name: "Test Connection" }).click();
  await expect(dialog.getByRole("group", { name: "Connection test result" })).toContainText(
    /e2e\/entered-draft.*entered key, nothing saved/,
  );
  expect(posted).toMatchObject({
    provider: "openrouter",
    model: "e2e/entered-draft",
    apiKey: "e2e-transient-key",
  });
  // Editing a tested input invalidates the result.
  await dialog.getByLabel("Primary model").fill("e2e/edited-draft");
  await expect(dialog.getByRole("group", { name: "Connection test result" })).toHaveCount(0);
  await page.unroute("/api/settings/ai-test");
});
