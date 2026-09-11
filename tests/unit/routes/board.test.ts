// @vitest-environment node
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, openDatabase } from "../../../src/db";
import { jobs } from "../../../src/db/schema";
import { GET } from "../../../app/api/board/route";
import {
  getRequest,
  readJson,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

describe("GET /api/board", () => {
  let isolated: IsolatedRoot;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-board-test-");
  });

  afterEach(() => {
    isolated.restoreEnv();
    isolated.cleanup();
  });

  function seedJob(status: string, title: string | null): string {
    const id = newId();
    const handle = openDatabase({
      path: join(isolated.root, "job-tracker.sqlite"),
    });
    try {
      handle.db
        .insert(jobs)
        .values({ id, status, title, rank: 0, rowVersion: 1 })
        .run();
    } finally {
      handle.close();
    }
    return id;
  }

  it("rejects rebinding hosts", async () => {
    const response = await GET(
      getRequest("/api/board", { host: "evil.example:3000" }),
    );
    expect(response.status).toBe(403);
  });

  it("validates sort, limit, offset, and q", async () => {
    for (const path of [
      "/api/board?sort=popularity",
      "/api/board?limit=0",
      "/api/board?limit=many",
      "/api/board?offset=-1",
      "/api/board?offset=soon",
      `/api/board?q=${"x".repeat(201)}`,
    ]) {
      const response = await GET(getRequest(path));
      expect(response.status).toBe(400);
    }
  });

  it("projects columns and honors search with pagination", async () => {
    seedJob("NEW", "Staff Engineer");
    seedJob("TAILORED", "Staff Engineer");
    seedJob("NEW", "Designer");
    const full = await GET(getRequest("/api/board"));
    expect(full.status).toBe(200);
    const body = await readJson(full);
    const columns = body["columns"] as { status: string; total: number; cards: unknown[] }[];
    expect(columns.map((column) => column.status)).toEqual([
      "NEW",
      "TAILORED",
      "APPLIED",
      "INTERVIEWED",
      "REJECTED",
    ]);
    expect(columns[0].total).toBe(2);
    expect(columns[1].total).toBe(1);

    const searched = await GET(getRequest("/api/board?q=staff"));
    const searchedBody = await readJson(searched);
    const searchedColumns = searchedBody["columns"] as { total: number }[];
    expect(searchedColumns[0].total).toBe(1);
    expect(searchedColumns[1].total).toBe(1);

    const paged = await GET(getRequest("/api/board?limit=1&offset=1"));
    const pagedBody = await readJson(paged);
    const pagedColumns = pagedBody["columns"] as {
      total: number;
      cards: { title: string }[];
    }[];
    expect(pagedColumns[0].total).toBe(2);
    expect(pagedColumns[0].cards).toHaveLength(1);
  });
});
