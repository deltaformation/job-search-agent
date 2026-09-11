/**
 * Shared startup preparation: resolve + validate runtime config, create
 * storage directories, and apply pending SQLite migrations. Used by
 * `dev.mjs`, `start.mjs`, and the `db:migrate` CLI.
 */
import "./ts-register.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function runSetup(env = process.env, root = REPO_ROOT) {
  const security = await import("../src/security/index.ts");
  const db = await import("../src/db/index.ts");
  const config = security.resolveRuntimeConfig(env, root);
  security.ensureDataRoot(config);
  const handle = db.ensureDatabase({
    path: config.databasePath,
    migrationsDir: join(root, "drizzle"),
  });
  handle.close();
  return config;
}
