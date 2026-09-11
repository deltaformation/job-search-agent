// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as listBatches } from "../../../app/api/intake/batches/route";
import { GET as getBatch } from "../../../app/api/intake/batches/[id]/route";
import { POST as submit } from "../../../app/api/intake/submit/route";
import {
  getRequest,
  postRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

describe("intake batch reads", () => {
  let isolated: IsolatedRoot;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-batches-test-");
  });

  afterEach(() => {
    isolated.restoreEnv();
    isolated.cleanup();
  });

  async function submitBatch(lines: string[]): Promise<string> {
    const response = await submit(postRequest("/api/intake/submit", { lines }));
    expect(response.status).toBe(200);
    return ((await readJson(response))["batchId"] as string) ?? "";
  }

  it("rejects rebinding hosts on reads", async () => {
    const response = await listBatches(
      getRequest("/api/intake/batches", { host: "evil.example:3000" }),
    );
    expect(response.status).toBe(403);
  });

  it("lists batches newest first with a clamped limit", async () => {
    const empty = await listBatches(getRequest("/api/intake/batches"));
    expect(empty.status).toBe(200);
    expect(((await readJson(empty))["batches"] as unknown[])).toEqual([]);
    const first = await submitBatch(["not a url one"]);
    const second = await submitBatch(["not a url two"]);
    const listed = await listBatches(getRequest("/api/intake/batches"));
    const batches = (await readJson(listed))["batches"] as Array<{ id: string }>;
    expect(batches.map((b) => b.id)).toEqual([second, first]);
    const clamped = await listBatches(getRequest("/api/intake/batches?limit=abc"));
    expect(clamped.status).toBe(200);
    expect(((await readJson(clamped))["batches"] as unknown[])).toHaveLength(2);
    const one = await listBatches(getRequest("/api/intake/batches?limit=1"));
    expect(((await readJson(one))["batches"] as unknown[])).toHaveLength(1);
  });

  it("shows one batch with per-line queue state", async () => {
    const batchId = await submitBatch(["not a url", "https://jobs.test/x"]);
    const response = await getBatch(
      getRequest(`/api/intake/batches/${batchId}`),
      routeParams(batchId),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body["id"]).toBe(batchId);
    const items = body["items"] as Array<{
      lineNumber: number;
      outcome: string;
      queue: unknown;
    }>;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ lineNumber: 1, outcome: "INVALID" });
    expect(items[0].queue).toBeNull();
    const missing = await getBatch(
      getRequest("/api/intake/batches/does-not-exist"),
      routeParams("does-not-exist"),
    );
    expect(missing.status).toBe(404);
  });
});
