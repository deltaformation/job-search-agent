#!/usr/bin/env node
/**
 * `npm run start` — prepare storage + migrations, then supervise the
 * production Next.js server and the worker. Requires `npm run build` first.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { flushStdio } from "./flush.mjs";
import { REPO_ROOT, runSetup } from "./setup-data.mjs";
import { supervise } from "./supervise.mjs";

try {
  if (!existsSync(join(REPO_ROOT, ".next", "BUILD_ID"))) {
    throw new Error("production build not found; run `npm run build` first");
  }
  const config = await runSetup(process.env);
  const childEnv = {
    APP_DATA_ROOT: config.root,
    DATABASE_PATH: config.databasePath,
    PORT: String(config.port),
    HOST: config.host,
  };
  const { code } = await supervise([
    {
      name: "web",
      argv: [
        process.execPath,
        join(REPO_ROOT, "node_modules/next/dist/bin/next"),
        "start",
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
      env: { ...childEnv, WORKER_ID: "worker" },
    },
  ]);
  process.exitCode = code;
} catch (error) {
  process.stderr.write(
    `start failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await flushStdio();
}
