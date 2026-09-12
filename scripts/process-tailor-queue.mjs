#!/usr/bin/env node
import { openDatabase } from "../src/db/client.ts";
import { getSharedBrowser, closeSharedBrowser } from "../src/scraping/browser.ts";
import { createTailorHandler } from "../src/tailoring/handler.ts";
import { CommandProvider } from "../src/tailoring/commandAdapter.ts";
import { runSetup } from "./setup-data.mjs";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnvFile(join(process.cwd(), ".env.local"));

const config = await runSetup(process.env);
const handle = openDatabase({ path: config.databasePath });

const providerArgv = process.env.TAILOR_PROVIDER_ARGV
  ? JSON.parse(process.env.TAILOR_PROVIDER_ARGV)
  : [process.execPath, join(process.cwd(), "scripts/tailor-provider.mjs")];

const provider = new CommandProvider({
  argv: providerArgv,
  timeoutMs: 120_000,
  maxOutputBytes: 524_288,
  model: process.env.OPENROUTER_MODEL || "google/gemma-4-26b-a4b-it:free",
});

const salaryArgv = process.env.SALARY_PROVIDER_ARGV
  ? JSON.parse(process.env.SALARY_PROVIDER_ARGV)
  : [process.execPath, join(process.cwd(), "scripts/extract-salary-facts.mjs")];

const handler = createTailorHandler({
  artifactsDir: config.artifactsDir,
  provider,
  browser: getSharedBrowser,
  salaryFallback:
    (process.env.SALARY_FALLBACK || "").trim().toLowerCase() === "off"
      ? undefined
      : { argv: salaryArgv, timeoutMs: 150_000, maxOutputBytes: 65_536 },
});

try {
  const items = handle.sqlite
    .prepare(
      "SELECT * FROM work_items WHERE kind = 'TAILOR' AND (state = 'QUEUED' OR state = 'FAILED') ORDER BY created_at ASC",
    )
    .all();

  console.log(`Found ${items.length} TAILOR items to process...`);

  for (const item of items) {
    // Retry recovery: re-arm a FAILED item so a previous crash or render
    // failure never strands it; SUCCEEDED items are never touched.
    if (item.state === "FAILED") {
      handle.sqlite
        .prepare("UPDATE work_items SET state = 'QUEUED', attempt_count = 0 WHERE id = ?")
        .run(item.id);
      item.state = "QUEUED";
    }
    console.log(`\n--- Processing item ${item.id} for job ${item.job_id} ---`);
    const context = {
      item: {
        ...item,
        payloadJson: item.payload_json,
        jobId: item.job_id,
        leaseToken: item.lease_token || "manual-lease",
      },
      handle,
      workerId: "manual-runner",
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      heartbeat: () => true,
    };

    const startedAt = new Date().toISOString();
    const outcome = await handler(context);
    const finishedAt = new Date().toISOString();
    console.log("Outcome:", JSON.stringify(outcome, null, 2));

    // Append-only attempt history (mirrors queue dispatch): without this
    // row, manual runs leave no error detail for the drawer's retry card.
    const attemptNumber =
      handle.sqlite
        .prepare("SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next FROM work_attempts WHERE work_item_id = ?")
        .get(item.id).next;
    handle.sqlite
      .prepare(
        `INSERT INTO work_attempts
           (id, work_item_id, attempt_number, worker_id, started_at, finished_at,
            input_hash, output_hash, result, error_code, error_detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        item.id,
        attemptNumber,
        "manual-runner",
        startedAt,
        finishedAt,
        outcome.inputHash ?? null,
        outcome.outputHash ?? null,
        outcome.result,
        outcome.errorCode ?? null,
        typeof outcome.errorDetail === "string" ? outcome.errorDetail.slice(0, 4000) : null,
      );

    // State mapping honors the work_items CHECK constraint
    // (QUEUED/RUNNING/SUCCEEDED/FAILED/CANCELLED): only a real success
    // lands SUCCEEDED; every error or blocked outcome lands FAILED.
    if (outcome.result === "SUCCEEDED") {
      handle.sqlite
        .prepare("UPDATE work_items SET state = 'SUCCEEDED', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), item.id);
    } else {
      if (outcome.result === "BLOCKED" && outcome.errorCode === "EXTRACTION_INCOMPLETE") {
        console.log(`Skipping job ${item.job_id} (no extraction text)`);
      }
      handle.sqlite
        .prepare("UPDATE work_items SET state = 'FAILED', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), item.id);
    }
  }
} finally {
  await closeSharedBrowser();
  handle.close();
}
