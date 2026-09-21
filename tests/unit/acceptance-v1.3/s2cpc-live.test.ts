// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../../../src/db";
import { readPlan, readPreparationByJob } from "../../../src/db/step2";
import { PreparationPlanV2 } from "../../../src/domain/step2Correction";
import { isProviderKeyConfigured } from "../../../src/server/preparation";
import { CommandProvider } from "../../../src/tailoring/commandAdapter";
import { createPrepareHandler } from "../../../src/tailoring/prepareHandler";
import { setupIsolatedRoot } from "../routes/_helpers";
import { claimS2b, finishS2bAttempt, s2bContext } from "./s2b-world";
import {
  clipAndScheduleLime,
  closeHarness,
  type LimeHarness,
} from "./s2cpc-world";

/**
 * WO-1.3-S2-CP-C live-provider leg (S2CPC5): one real remote
 * preparation over the Lime pairing through the production
 * sidecar (`scripts/prepare-provider.mjs`) and the real PREPARE
 * handler. Opt-in only: runs only with `S2CPC_LIVE=1` plus a
 * configured key (see below); plain `npm test` always skips it,
 * so the suite can never spend money or touch the network by
 * accident.
 *
 * Credentials come from the repo `.env.local` (the app's own
 * settings backing file); key VALUES are never logged, asserted,
 * or persisted — only presence and the provider id are observed.
 * The run executes against an isolated database that is discarded
 * afterwards; no production rows are touched.
 */

const LIVE = process.env["S2CPC_LIVE"] === "1";

function loadEnvFileKeys(): Record<string, string> {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) {
    return {};
  }
  const found: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const cut = trimmed.indexOf("=");
    if (cut < 0) {
      continue;
    }
    const key = trimmed.slice(0, cut).trim();
    let value = trimmed.slice(cut + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (
      (key === "ACTIVE_AI_PROVIDER" ||
        key === "OPENROUTER_API_KEY" ||
        key === "GEMINI_API_KEY" ||
        key === "META_API_KEY") &&
      value !== ""
    ) {
      found[key] = value;
    }
  }
  return found;
}

describe.skipIf(!LIVE)("S2CPC5 live remote preparation", () => {
  let harness: LimeHarness;

  beforeEach(() => {
    // Real keys for this run only; restored afterwards. The
    // shared keyedEnv helper would overwrite them with test-key.
    const isolated = setupIsolatedRoot("job-tracker-v13-s2cpc-live-");
    const savedEnv: Record<string, string | undefined> = {};
    const keys = loadEnvFileKeys();
    for (const [key, value] of Object.entries(keys)) {
      if (!(key in savedEnv)) {
        savedEnv[key] = process.env[key];
      }
      process.env[key] = value;
    }
    const withDb = <T,>(fn: (handle: DatabaseHandle) => T | Promise<T>): Promise<T> => {
      const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
      return Promise.resolve()
        .then(() => fn(handle))
        .finally(() => handle.close());
    };
    harness = { isolated, savedEnv, withDb };
  });

  afterEach(() => {
    closeHarness(harness);
  });

  it(
    "a configured remote provider completes one Lime preparation round trip",
    async () => {
      if (!isProviderKeyConfigured(process.env)) {
        throw new Error(
          "S2CPC_LIVE=1 but no provider key is configured (ACTIVE_AI_PROVIDER key missing)",
        );
      }
      const scheduled = await clipAndScheduleLime(harness);
      const { basics, now } = scheduled;
      const provider = new CommandProvider({
        argv: [process.execPath, join(process.cwd(), "scripts", "prepare-provider.mjs")],
        timeoutMs: 180_000,
        maxOutputBytes: 65_536,
        model: null,
      });
      const claimed = await harness.withDb((handle) => claimS2b(handle, { now }));
      const handler = createPrepareHandler({ provider, clock: () => now });
      const outcome = await harness.withDb((handle) => handler(s2bContext(handle, claimed)));
      // A completed round trip is the assertion: the remote call
      // returned and the handler filed a terminal outcome. Either
      // branch records its evidence below.
      expect(["SUCCEEDED", "FAILED"]).toContain(outcome.result);
      await harness.withDb((handle) => finishS2bAttempt(handle, { ...claimed, outcome, now }));
      const row = await harness.withDb((handle) => readPreparationByJob(handle, basics.jobId));
      if (row === null) {
        throw new Error("live run lost the preparation row");
      }
      if (outcome.result === "SUCCEEDED") {
        if (row.acceptedPlanId === null || row.acceptedPlanId === undefined) {
          throw new Error("live PREPARE succeeded without an accepted plan");
        }
        const planId = row.acceptedPlanId;
        const stored = await harness.withDb((handle) => readPlan(handle, planId));
        if (stored === null) {
          throw new Error("live accepted plan is unreadable");
        }
        const plan = PreparationPlanV2.parse(JSON.parse(stored.planJson) as unknown);
        expect(plan.priorities.length).toBeGreaterThan(0);
        expect(stored.planHash).toMatch(/^[0-9a-f]{64}$/);
      } else {
        // Failed round trips stay honest: a known handler code,
        // never a crash, and no accepted plan.
        expect(outcome.errorCode).toMatch(
          /^(INVALID_RESPONSE|AUTHENTICATION|RATE_LIMIT|PROVIDER_TIMEOUT|NETWORK|LOCAL_LAUNCH)$/,
        );
        expect(row.acceptedPlanId).toBeNull();
      }
    },
    240_000,
  );
});
