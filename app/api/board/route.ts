import {
  getBoardView,
  type BoardSort,
} from "../../../src/server/board";
import { jsonError, openRequestDatabase, readGate } from "../_lib/request";

/**
 * Five-column board projection. `?q=` substring-matches title/company/
 * location (LIKE wildcards escaped), `?sort=` is rank (default), updated,
 * or created, and `?limit=`/`?offset=` page each column. Every column
 * always appears so empty states stay explicit.
 */
export const dynamic = "force-dynamic";

const SORTS: readonly BoardSort[] = ["rank", "updated", "created"];

export async function GET(request: Request): Promise<Response> {
  const gate = readGate(request);
  if (gate !== null) {
    return gate;
  }
  const params = new URL(request.url).searchParams;
  const rawSort = params.get("sort");
  if (rawSort !== null && !(SORTS as readonly string[]).includes(rawSort)) {
    return jsonError(400, "invalid request", "sort must be rank, updated, or created");
  }
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isFinite(limit) || Math.trunc(limit) < 1)) {
    return jsonError(400, "invalid request", "limit must be a positive integer");
  }
  const rawOffset = params.get("offset");
  const offset = rawOffset === null ? undefined : Number(rawOffset);
  if (offset !== undefined && (!Number.isFinite(offset) || Math.trunc(offset) < 0)) {
    return jsonError(400, "invalid request", "offset must be a non-negative integer");
  }
  const rawQ = params.get("q");
  if (rawQ !== null && rawQ.length > 200) {
    return jsonError(400, "invalid request", "q must be at most 200 characters");
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    return Response.json(
      getBoardView(database.handle, {
        q: rawQ === null || rawQ.trim() === "" ? undefined : rawQ,
        sort: (rawSort ?? "rank") as BoardSort,
        limit,
        offset,
      }),
    );
  } finally {
    database.release();
  }
}
