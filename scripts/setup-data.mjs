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
  const settings = await import("../src/server/settings.ts");
  const sources = await import("../src/server/sources.ts");
  const config = security.resolveRuntimeConfig(env, root);
  security.ensureDataRoot(config);
  const handle = db.ensureDatabase({
    path: config.databasePath,
    migrationsDir: join(root, "drizzle"),
  });
  try {
    // Ordered upgrade step (WO-1.2-B): reconstruct profile source bytes
    // for pre-upgrade active versions, then quarantine crashed-publish
    // debris. Both are idempotent no-ops once converged.
    sources.backfillProfileSources(handle, {
      sourcesDir: config.sourcesDir,
      candidateDir: settings.resolveCandidateDir(env),
    });
    sources.reconcileSources(handle, config.sourcesDir);
  } finally {
    handle.close();
  }
  return config;
}
