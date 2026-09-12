// @vitest-environment node
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, openDatabase, workItems } from "../../../src/db";
import { GET } from "../../../app/api/attempts/[id]/route";
import { POST as retry } from "../../../app/api/attempts/[id]/retry/route";
import {
  getRequest,
  postRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

describe("attempt reads and retry", () => {
  let isolated: IsolatedRoot;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-attempts-test-");
  });

  afterEach(() => {
    isolated.restoreEnv();
    isolated.cleanup();
  });

  function insertWorkItem(state: string): string {
    const id = newId();
    const handle = openDatabase({
      path: join(isolated.root, "job-tracker.sqlite"),
    });
    try {
      handle.db
        .insert(workItems)
        .values({
          id,
          kind: "SCRAPE",
          idempotencyKey: `key-${id}`,
          payloadJson: "{}",
          state,
          attemptCount: state === "QUEUED" ? 0 : 1,
          maxAttempts: 3,
        })
        .run();
    } finally {
      handle.close();
    }
    return id;
  }

  it("rejects rebinding hosts and unknown ids", async () => {
    const forbidden = await GET(
      getRequest("/api/attempts/x", { host: "evil.example:3000" }),
      routeParams("x"),
    );
    expect(forbidden.status).toBe(403);
    const missing = await GET(
      getRequest("/api/attempts/does-not-exist"),
      routeParams("does-not-exist"),
    );
    expect(missing.status).toBe(404);
    const retryMissing = await retry(
      postRequest("/api/attempts/does-not-exist/retry", {}),
      routeParams("does-not-exist"),
    );
    expect(retryMissing.status).toBe(404);
  });

  it("shows a queued item with no attempts yet", async () => {
    const id = insertWorkItem("QUEUED");
    const response = await GET(
      getRequest(`/api/attempts/${id}`),
      routeParams(id),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    const workItem = body["workItem"] as Record<string, unknown>;
    expect(workItem).toMatchObject({ id, state: "QUEUED", attemptCount: 0 });
    expect(body["attempts"]).toEqual([]);
    expect(body["job"]).toBeNull();
  });

  it("retries failed items and refuses anything else", async () => {
    const failed = insertWorkItem("FAILED");
    const retryFailed = await retry(
      postRequest(`/api/attempts/${failed}/retry`, {}),
      routeParams(failed),
    );
    expect(retryFailed.status).toBe(200);
    expect(await readJson(retryFailed)).toMatchObject({ state: "QUEUED" });
    const after = await GET(
      getRequest(`/api/attempts/${failed}`),
      routeParams(failed),
    );
    const workItem = (await readJson(after))["workItem"] as Record<string, unknown>;
    // Human retry preserves the recorded attempt counter and extends the
    // budget instead of restarting the counter into kept history.
    expect(workItem).toMatchObject({ state: "QUEUED", attemptCount: 1, maxAttempts: 4 });

    const queued = insertWorkItem("QUEUED");
    const retryQueued = await retry(
      postRequest(`/api/attempts/${queued}/retry`, {}),
      routeParams(queued),
    );
    expect(retryQueued.status).toBe(409);
    const done = insertWorkItem("SUCCEEDED");
    const retryDone = await retry(
      postRequest(`/api/attempts/${done}/retry`, {}),
      routeParams(done),
    );
    expect(retryDone.status).toBe(409);
  });

  it("gates retry mutations by origin", async () => {
    const id = insertWorkItem("FAILED");
    const response = await retry(
      postRequest(`/api/attempts/${id}/retry`, {}, {
        host: "127.0.0.1:3000",
        origin: "http://evil.example:3000",
      }),
      routeParams(id),
    );
    expect(response.status).toBe(403);
  });
});
