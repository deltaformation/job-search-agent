#!/usr/bin/env node
/**
 * `npm run dev` — prepare storage + migrations, then supervise Next.js
 * development mode and the worker. Loopback-only; forwards SIGINT/SIGTERM
 * to both children and exits non-zero if either fails.
 */
import { join } from "node:path";
import { flushStdio } from "./flush.mjs";
import { REPO_ROOT, runSetup } from "./setup-data.mjs";
import { supervise } from "./supervise.mjs";

try {
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
