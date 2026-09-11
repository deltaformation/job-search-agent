import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDatabase, resolveMigrationsDir } from "../../../src/db";

/**
 * Isolated data root for route tests. Handlers resolve storage from
 * `APP_DATA_ROOT`, so each test file points it at a migrated temporary
 * directory and restores it after — the user's real database is never
 * opened.
 */

export interface IsolatedRoot {
  root: string;
  restoreEnv: () => void;
  cleanup: () => void;
}

export function setupIsolatedRoot(prefix: string): IsolatedRoot {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const previous = process.env["APP_DATA_ROOT"];
  process.env["APP_DATA_ROOT"] = root;
  const handle = ensureDatabase({
    path: join(root, "job-tracker.sqlite"),
    migrationsDir: resolveMigrationsDir(),
  });
  handle.close();
  // Mirror the supervisor, which prepares storage directories on boot.
  mkdirSync(join(root, "evidence"), { recursive: true });
  return {
    root,
    restoreEnv: () => {
      if (previous === undefined) {
        delete process.env["APP_DATA_ROOT"];
      } else {
        process.env["APP_DATA_ROOT"] = previous;
      }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function mutationHeaders(): Record<string, string> {
  return {
    host: "127.0.0.1:3000",
    origin: "http://127.0.0.1:3000",
  };
}

export function readHeaders(): Record<string, string> {
  return { host: "127.0.0.1:3000" };
}

export function postRequest(
  path: string,
  body: unknown,
  headers: Record<string, string> = mutationHeaders(),
): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getRequest(
  path: string,
  headers: Record<string, string> = readHeaders(),
): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "GET",
    headers,
  });
}

export function routeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}
