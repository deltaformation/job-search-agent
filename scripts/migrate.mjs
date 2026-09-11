#!/usr/bin/env node
/**
 * `npm run db:migrate` — prepare the data root and apply pending migrations
 * without starting any process. Exit 0 when the database is ready.
 */
import { flushStdio } from "./flush.mjs";
import { runSetup } from "./setup-data.mjs";

try {
  const config = await runSetup(process.env);
  process.stdout.write(`database ready: ${config.databasePath}\n`);
} catch (error) {
  process.stderr.write(
    `setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await flushStdio();
}
