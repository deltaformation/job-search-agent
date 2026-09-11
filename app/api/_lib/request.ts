import type { z } from "zod";
import {
  openDatabase,
  type DatabaseHandle,
  type SqliteConnection,
} from "../../../src/db/client";
import {
  dataRootStatus,
  resolveDataRoot,
} from "../../../src/security/data-root";
import {
  defaultLocalHosts,
  defaultLocalOrigins,
  verifyMutationRequest,
  verifyReadRequest,
} from "../../../src/security/origin";

/**
 * Shared route plumbing. Every R2-E handler gates Host/Origin first,
 * opens one request-scoped database second, and closes it in a finally.
 * Routes never create storage or run migrations: a missing or
 * unmigrated database is a 503 with an actionable message, because the
 * supervisor owns lifecycle and silent creation would mask broken setup.
 */

export interface RoutePolicy {
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
}

export function routePolicy(
  env: Record<string, string | undefined> = process.env,
): RoutePolicy {
  const port = Number(env["PORT"] ?? 3000);
  return {
    allowedHosts: defaultLocalHosts(port),
    allowedOrigins: defaultLocalOrigins(port),
  };
}

export function jsonError(status: number, error: string, reason?: string): Response {
  return Response.json(reason === undefined ? { error } : { error, reason }, {
    status,
  });
}

/** 403 response when a mutation fails Host/Origin checks, else null. */
export function mutationGate(request: Request, policy?: RoutePolicy): Response | null {
  const check = verifyMutationRequest(
    {
      host: request.headers.get("host"),
      origin: request.headers.get("origin"),
      secFetchSite: request.headers.get("sec-fetch-site"),
    },
    policy ?? routePolicy(),
  );
  if (check.ok) {
    return null;
  }
  const detail =
    check.reason === "bad-host"
      ? "request host is not this local app"
      : check.reason === "bad-origin"
        ? "request origin is not this local app"
        : "mutations must send an Origin header or same-origin fetch metadata";
  return jsonError(403, "forbidden", detail);
}

/** 403 response when a read fails Host checks, else null. */
export function readGate(request: Request, policy?: RoutePolicy): Response | null {
  const resolved = policy ?? routePolicy();
  if (verifyReadRequest(request.headers.get("host"), resolved)) {
    return null;
  }
  return jsonError(403, "forbidden", "request host is not this local app");
}

function hasProductTables(sqlite: SqliteConnection): boolean {
  const row = sqlite
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'jobs'",
    )
    .get() as { count: number };
  return row.count === 1;
}

export type RequestDatabase =
  | { ok: true; handle: DatabaseHandle; release: () => void }
  | { ok: false; response: Response };

/**
 * Open the prepared product database for one request. The caller must
 * call `release()` in a `finally`; every route below does.
 */
export function openRequestDatabase(
  env: Record<string, string | undefined> = process.env,
): RequestDatabase {
  let paths: ReturnType<typeof resolveDataRoot>;
  try {
    paths = resolveDataRoot(env);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      response: jsonError(500, "data root misconfigured", detail),
    };
  }
  if (!dataRootStatus(paths).databaseExists) {
    return {
      ok: false,
      response: jsonError(
        503,
        "database not initialized",
        "start the app through the supervisor so migrations run first",
      ),
    };
  }
  const handle = openDatabase({ path: paths.databasePath });
  if (!hasProductTables(handle.sqlite)) {
    handle.close();
    return {
      ok: false,
      response: jsonError(
        503,
        "database not migrated",
        "start the app through the supervisor so migrations run first",
      ),
    };
  }
  return { ok: true, handle, release: () => handle.close() };
}

export type ParsedBody<T> =
  | { ok: true; value: T }
  | { ok: false; response: Response };

/** Parse a JSON body through a Zod schema; malformed input is a 400. */
export async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<ParsedBody<T>> {
  let data: unknown;
  try {
    data = (await request.json()) as unknown;
  } catch {
    return { ok: false, response: jsonError(400, "malformed JSON body") };
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      response: jsonError(400, "invalid request", parsed.error.issues[0]?.message ?? "schema mismatch"),
    };
  }
  return { ok: true, value: parsed.data };
}
