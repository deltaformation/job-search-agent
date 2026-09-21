#!/usr/bin/env node
/**
 * `npm run dev` — prepare storage + migrations, then supervise Next.js
 * development mode and the worker. Loopback-only; forwards SIGINT/SIGTERM
 * to both children and exits non-zero if either fails.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { flushStdio } from "./flush.mjs";
import { REPO_ROOT, runSetup } from "./setup-data.mjs";
import { supervise } from "./supervise.mjs";

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

loadEnvFile(join(REPO_ROOT, ".env.local"));

try {
  const config = await runSetup(process.env);
  const defaultTailorArgv = JSON.stringify([
    process.execPath,
    join(REPO_ROOT, "scripts/tailor-provider.mjs"),
  ]);
  // Provider configuration (WO-1.2-G): web and worker boot from the
  // same values so activation applies to both on restart. The
  // supervisor already inherits the full environment; these explicit
  // entries document the contract and survive any future narrowing.
  const childEnv = {
    APP_DATA_ROOT: config.root,
    DATABASE_PATH: config.databasePath,
    PORT: String(config.port),
    HOST: config.host,
    TAILOR_PROVIDER_ARGV: process.env.TAILOR_PROVIDER_ARGV || defaultTailorArgv,
    ...(process.env.ACTIVE_AI_PROVIDER ? { ACTIVE_AI_PROVIDER: process.env.ACTIVE_AI_PROVIDER } : {}),
    ...(process.env.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY } : {}),
    ...(process.env.OPENROUTER_MODEL ? { OPENROUTER_MODEL: process.env.OPENROUTER_MODEL } : {}),
    ...(process.env.OPENROUTER_FALLBACK_MODEL ? { OPENROUTER_FALLBACK_MODEL: process.env.OPENROUTER_FALLBACK_MODEL } : {}),
    ...(process.env.GEMINI_API_KEY ? { GEMINI_API_KEY: process.env.GEMINI_API_KEY } : {}),
    ...(process.env.GEMINI_MODEL ? { GEMINI_MODEL: process.env.GEMINI_MODEL } : {}),
    ...(process.env.GEMINI_FALLBACK_MODEL ? { GEMINI_FALLBACK_MODEL: process.env.GEMINI_FALLBACK_MODEL } : {}),
    ...(process.env.META_API_KEY ? { META_API_KEY: process.env.META_API_KEY } : {}),
    ...(process.env.META_MODEL ? { META_MODEL: process.env.META_MODEL } : {}),
    ...(process.env.META_FALLBACK_MODEL ? { META_FALLBACK_MODEL: process.env.META_FALLBACK_MODEL } : {}),
  };
  const { code } = await supervise([
    {
      name: "web",
      argv: [
        process.execPath,
        join(REPO_ROOT, "node_modules/next/dist/bin/next"),
        "dev",
        "--hostname",
        config.host,
        "--port",
        String(config.port),
      ],
      cwd: REPO_ROOT,
      env: childEnv,
    },
    {
      name: "worker",
      argv: [
        process.execPath,
        "--import",
        "./scripts/ts-register.mjs",
        "./src/worker/main.ts",
      ],
      cwd: REPO_ROOT,
      env: { ...childEnv, WORKER_ID: "worker-dev" },
    },
  ]);
  process.exitCode = code;
} catch (error) {
  process.stderr.write(
    `dev startup failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await flushStdio();
}
