import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Product data-root configuration. The default root is `data/rebuild/`
 * under the working directory (git-ignored); `APP_DATA_ROOT` overrides it
 * for tests, packaging, or relocated installs. Development and tests must
 * pass an isolated root and never touch the user's normal database.
 */

export const DATABASE_FILENAME = "job-tracker.sqlite";
export const EVIDENCE_DIR_NAME = "evidence";
export const ARTIFACTS_DIR_NAME = "artifacts";
export const SOURCES_DIR_NAME = "sources";

export interface DataRootPaths {
  root: string;
  databasePath: string;
  evidenceDir: string;
  artifactsDir: string;
  sourcesDir: string;
}

export function defaultDataRoot(cwd: string = process.cwd()): string {
  return join(cwd, "data", "rebuild");
}

export function resolveDataRoot(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): DataRootPaths {
  const root = env.APP_DATA_ROOT?.trim() || defaultDataRoot(cwd);
  const override = env.DATABASE_PATH?.trim();
  return {
    root,
    databasePath:
      override === undefined || override === ""
        ? join(root, DATABASE_FILENAME)
        : override,
    evidenceDir: join(root, EVIDENCE_DIR_NAME),
    artifactsDir: join(root, ARTIFACTS_DIR_NAME),
    sourcesDir: join(root, SOURCES_DIR_NAME),
  };
}

/** Create the root and its storage directories (idempotent). */
export function ensureDataRoot(paths: DataRootPaths): void {
  try {
    mkdirSync(paths.evidenceDir, { recursive: true });
    mkdirSync(paths.artifactsDir, { recursive: true });
    mkdirSync(paths.sourcesDir, { recursive: true });
  } catch (error) {
    throw new Error(`cannot create data directories under ${paths.root}`, {
      cause: error,
    });
  }
}

export interface DataRootStatus extends DataRootPaths {
  rootExists: boolean;
  databaseExists: boolean;
  evidenceExists: boolean;
  artifactsExists: boolean;
  sourcesExists: boolean;
}

/** Non-throwing inventory for health checks and startup diagnostics. */
export function dataRootStatus(paths: DataRootPaths): DataRootStatus {
  return {
    ...paths,
    rootExists: existsSync(paths.root),
    databaseExists: existsSync(paths.databasePath),
    evidenceExists: existsSync(paths.evidenceDir),
    artifactsExists: existsSync(paths.artifactsDir),
    sourcesExists: existsSync(paths.sourcesDir),
  };
}
