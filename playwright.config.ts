import { defineConfig, devices } from "@playwright/test";

/**
 * Board E2E: boots the real supervisor (web + worker) against an isolated
 * `.e2e-data` root seeded by global-setup, then drives /board in Chromium.
 * Run on a machine with browsers installed:
 *   npx playwright install chromium && npm run test:e2e
 */
export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3107",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node ./scripts/dev.mjs",
    url: "http://127.0.0.1:3107/api/health",
    // Never reuse: global-setup wipes .e2e-data, so a stale server would
    // hold a deleted database.
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      APP_DATA_ROOT: "./.e2e-data",
      PORT: "3107",
      NEXT_DIST_DIR: ".next-e2e",
    },
  },
});
