import { NextResponse } from "next/server";
import type { z } from "zod";
import { openDatabase, type DatabaseHandle } from "@/src/db/client";
import {
  parseWorkspaceETag,
  type TailoringErrorBody as TailoringErrorBodyType,
} from "@/src/domain/tailoringWorkspace";
import { dataRootStatus, resolveDataRoot } from "@/src/security/data-root";
import { verifyMutationRequest, verifyReadRequest } from "@/src/security/origin";
import type { WorkspaceFailure } from "@/src/server/tailoringWorkspace";
import { routePolicy } from "./request";

/**
 * Shared v1.3 tailoring API helpers (WO-1.3-B; reused by E/F/G).
 * Every response uses the ErrorBody envelope with
 * `Cache-Control: no-store`; request bodies are capped at 128 KiB
 * before JSON parsing (413); workspace writes require exactly one
 * If-Match ETag (428/400/412).
 */

export const MAX_TAILORING_BODY_BYTES = 131072;

type ErrorCode = TailoringErrorBodyType["error"]["code"];
type ErrorAction = TailoringErrorBodyType["error"]["action"];

export interface TailoringErrorOptions {
  field?: string;
  currentWorkspaceRevision?: number;
  currentRowVersion?: number;
  requestId?: string;
  action?: ErrorAction;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

export function tailoringError(
  status: number,
  code: ErrorCode,
  message: string,
  options: TailoringErrorOptions = {},
): NextResponse {
  const body: TailoringErrorBodyType = {
    ok: false,
    error: {
      code,
      message: truncate(message, 280),
      ...(options.field === undefined ? {} : { field: truncate(options.field, 128) }),
      ...(options.currentWorkspaceRevision === undefined
        ? {}
        : { currentWorkspaceRevision: options.currentWorkspaceRevision }),
      ...(options.currentRowVersion === undefined
        ? {}
        : { currentRowVersion: options.currentRowVersion }),
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
      action: options.action ?? null,
    },
  };
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function tailoringReadGate(request: Request, env: NodeJS.ProcessEnv): NextResponse | null {
  const policy = routePolicy(env);
  if (!verifyReadRequest(request.headers.get("host"), policy)) {
    return tailoringError(403, "FORBIDDEN", "request host is not this local app");
  }
  return null;
}

export function tailoringMutationGate(
  request: Request,
  env: NodeJS.ProcessEnv,
): NextResponse | null {
  const check = verifyMutationRequest(
    {
      host: request.headers.get("host"),
      origin: request.headers.get("origin"),
      secFetchSite: request.headers.get("sec-fetch-site"),
    },
    routePolicy(env),
  );
  if (!check.ok) {
    const detail =
      check.reason === "bad-host"
        ? "request host is not this local app"
        : check.reason === "bad-origin"
          ? "request origin is not this local app"
          : "mutations require an explicit same-origin signal";
    return tailoringError(403, "FORBIDDEN", detail);
  }
  return null;
}

export function tailoringPathId(id: string): { ok: true } | { ok: false; response: NextResponse } {
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    return {
      ok: false,
      response: tailoringError(400, "INVALID_REQUEST", `path id ${id} is not a UUID`, {
        field: "id",
      }),
    };
  }
  return { ok: true };
}

export type TailoringDatabase =
  | { ok: true; handle: DatabaseHandle; close: () => void }
  | { ok: false; response: NextResponse };

/**
 * Open the prepared product database for one request (same lifecycle
 * rules as `openRequestDatabase`: the caller closes in a `finally`,
 * and startup failures become ErrorBody storage errors, never
 * silent creation or migration).
 */
export function openTailoringDatabase(env: NodeJS.ProcessEnv): TailoringDatabase {
  let paths: ReturnType<typeof resolveDataRoot>;
  try {
    paths = resolveDataRoot(env);
  } catch {
    return {
      ok: false,
      response: tailoringError(
        500,
        "STORAGE_UNAVAILABLE",
        "local data root is misconfigured; start the app through the supervisor",
      ),
    };
  }
  if (!dataRootStatus(paths).databaseExists) {
    return {
      ok: false,
      response: tailoringError(
        503,
        "STORAGE_UNAVAILABLE",
        "local database is not initialized; start the app through the supervisor",
      ),
    };
  }
  const handle = openDatabase({ path: paths.databasePath });
  const row = handle.sqlite
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")
    .get() as { count: number };
  if (row.count !== 1) {
    handle.close();
    return {
      ok: false,
      response: tailoringError(
        503,
        "STORAGE_UNAVAILABLE",
        "local database migrations are pending; restart the app to finish the upgrade",
      ),
    };
  }
  return { ok: true, handle, close: () => handle.close() };
}

export type CappedBodyResult<T> =
  | { ok: true; value: T }
  | { ok: false; response: NextResponse };

/**
 * Read a JSON body capped at 128 KiB. Oversize → 413, malformed
 * JSON or schema failure → 400 INVALID_REQUEST with the first
 * issue's dotted field path.
 */
/** Map a Zod failure to the 400 INVALID_REQUEST envelope (shared shape pin). */
export function zodInvalidRequest(error: z.ZodError): NextResponse {
  const issue = error.issues[0];
  const field = issue?.path.map((segment) => String(segment)).join(".") || undefined;
  return tailoringError(400, "INVALID_REQUEST", issue?.message ?? "invalid request body", {
    ...(field === undefined ? {} : { field }),
  });
}

export async function parseCappedJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<CappedBodyResult<T>> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_TAILORING_BODY_BYTES) {
    return {
      ok: false,
      response: tailoringError(
        413,
        "INVALID_REQUEST",
        `request body exceeds the ${MAX_TAILORING_BODY_BYTES}-byte limit`,
      ),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      response: tailoringError(400, "INVALID_REQUEST", "request body is not valid JSON"),
    };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, response: zodInvalidRequest(result.error) };
  }
  return { ok: true, value: result.data };
}

export type IfMatchResult =
  | { ok: true; observedRevision: number }
  | { ok: false; response: NextResponse };

/**
 * Gate a workspace write on exactly one If-Match ETag: absent →
 * 428, wildcard/list/malformed → 400, wrong job → 412. Revision
 * mismatches are detected by the service CAS (412 with the current
 * revision); a job-mismatched ETag is a client bug, so the client
 * re-reads via GET for the true revision.
 */
export function ifMatchWorkspace(request: Request, jobId: string): IfMatchResult {
  const raw = request.headers.get("if-match");
  if (raw === null) {
    return {
      ok: false,
      response: tailoringError(
        428,
        "PRECONDITION_REQUIRED",
        "workspace writes require exactly one If-Match revision",
        { action: "reload" },
      ),
    };
  }
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "*" || trimmed.includes(",")) {
    return {
      ok: false,
      response: tailoringError(
        400,
        "INVALID_REQUEST",
        "If-Match must carry exactly one workspace revision ETag",
        { field: "If-Match" },
      ),
    };
  }
  const parsed = parseWorkspaceETag(trimmed);
  if (parsed === null) {
    return {
      ok: false,
      response: tailoringError(
        400,
        "INVALID_REQUEST",
        "If-Match is not a workspace revision ETag",
        { field: "If-Match" },
      ),
    };
  }
  if (parsed.jobId !== jobId) {
    return {
      ok: false,
      response: tailoringError(412, "WORKSPACE_CONFLICT", "If-Match job does not match the path job", {
        action: "reload",
      }),
    };
  }
  return { ok: true, observedRevision: parsed.revision };
}

/** Map workspace service failures to their ErrorBody status + code. */
export function workspaceFailureResponse(failure: WorkspaceFailure): NextResponse {
  switch (failure.error) {
    case "unknown-job":
    case "not-found":
      return tailoringError(404, "NOT_FOUND", failure.detail, { field: failure.field });
    case "workspace-conflict":
      return tailoringError(412, "WORKSPACE_CONFLICT", failure.detail, {
        currentWorkspaceRevision: failure.currentWorkspaceRevision,
        action: "reload",
      });
    case "input-stale":
      return tailoringError(409, "INPUT_STALE", failure.detail, {
        field: failure.field,
        currentWorkspaceRevision: failure.currentWorkspaceRevision,
        action: "reload",
      });
    case "plan-stale":
      return tailoringError(409, "PLAN_STALE", failure.detail, {
        field: failure.field,
        action: "reload",
      });
    case "invalid-selection":
      return tailoringError(422, "INVALID_SELECTION", failure.detail, {
        field: failure.field,
        action: "edit_focus",
      });
    case "invalid-request":
      return tailoringError(400, "INVALID_REQUEST", failure.detail, { field: failure.field });
    case "storage-unavailable":
      return tailoringError(503, "STORAGE_UNAVAILABLE", failure.detail);
  }
}

export function tailoringJson(status: number, body: unknown, etag?: string): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(etag === undefined ? {} : { ETag: etag }),
    },
  });
}
