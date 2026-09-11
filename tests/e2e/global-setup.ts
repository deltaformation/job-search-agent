import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureDatabase, openDatabase } from "../../src/db/client";
import { newId } from "../../src/db/utils";
import { jobNotes, jobSources, jobs } from "../../src/db/schema";
import { ensureDataRoot, resolveRuntimeConfig } from "../../src/security/index";

/**
 * E2E seed: wipes .e2e-data, migrates a fresh database, and inserts a
 * deterministic board (two NEW cards, one TAILORED card with a note).
 * Runs before the web server boots; the supervisor's own setup is a
 * no-op on top of the migrated database.
 */
export default async function globalSetup(): Promise<void> {
  const root = join(process.cwd(), ".e2e-data");
  rmSync(root, { recursive: true, force: true });
  const env = { ...process.env, APP_DATA_ROOT: root, PORT: "3107" };
  const config = resolveRuntimeConfig(env, process.cwd());
  ensureDataRoot(config);
  mkdirSync(join(root, "evidence"), { recursive: true });
  const migrated = ensureDatabase({
    path: config.databasePath,
    migrationsDir: join(process.cwd(), "drizzle"),
  });
  migrated.close();

  const handle = openDatabase({ path: config.databasePath });
  try {
    const alpha = newId();
    handle.db
      .insert(jobs)
      .values({
        id: alpha,
        status: "NEW",
        rank: 0,
        rowVersion: 1,
        title: "E2E Alpha Engineer",
        company: "Probe Corp",
        location: "Remote",
      })
      .run();
    handle.db
      .insert(jobSources)
      .values({
        id: newId(),
        jobId: alpha,
        submittedUrl: "https://example.com/jobs/e2e-alpha",
        canonicalUrl: "https://example.com/jobs/e2e-alpha",
        canonicalKey: "url:https://example.com/jobs/e2e-alpha",
      })
      .run();
    const beta = newId();
    handle.db
      .insert(jobs)
      .values({
        id: beta,
        status: "NEW",
        rank: 1,
        rowVersion: 1,
        title: "E2E Beta Designer",
        company: "Probe Corp",
        location: "Berlin",
      })
      .run();
    const gamma = newId();
    handle.db
      .insert(jobs)
      .values({
        id: gamma,
        status: "NEW",
        rank: 2,
        rowVersion: 1,
        title: "E2E Gamma Tester",
        company: "Probe Corp",
      })
      .run();
    const tailored = newId();
    handle.db
      .insert(jobs)
      .values({
        id: tailored,
        status: "TAILORED",
        rank: 0,
        rowVersion: 1,
        title: "E2E Tailored Analyst",
        company: "Probe Corp",
      })
      .run();
    handle.db
      .insert(jobNotes)
      .values({ id: newId(), jobId: tailored, body: "seeded note" })
      .run();
  } finally {
    handle.close();
  }
}
