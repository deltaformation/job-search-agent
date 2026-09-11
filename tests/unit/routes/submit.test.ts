// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "../../../app/api/intake/submit/route";
import {
  postRequest,
  readJson,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

describe("POST /api/intake/submit", () => {
  let isolated: IsolatedRoot;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-submit-test-");
  });

  afterEach(() => {
    isolated.restoreEnv();
    isolated.cleanup();
  });

  it("rejects forged hosts and origins", async () => {
    const badHost = await POST(
      postRequest("/api/intake/submit", { lines: [] }, {
        host: "evil.example:3000",
        origin: "http://127.0.0.1:3000",
      }),
    );
    expect(badHost.status).toBe(403);
    const badOrigin = await POST(
      postRequest("/api/intake/submit", { lines: [] }, {
        host: "127.0.0.1:3000",
        origin: "http://evil.example:3000",
      }),
    );
    expect(badOrigin.status).toBe(403);
  });

  it("persists the batch with per-line outcomes and counts", async () => {
    const response = await POST(
      postRequest("/api/intake/submit", {
        lines: ["not a url", "https://jobs.test/posting/1"],
      }),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(typeof body["batchId"]).toBe("string");
    const counts = body["counts"] as Record<string, number>;
    expect(counts).toMatchObject({
      rawLineCount: 2,
      enqueuedCount: 0,
      invalidCount: 2,
    });
    const results = body["results"] as Array<{
      outcome: string;
      intakeItemId: string;
    }>;
    expect(results).toHaveLength(2);
    expect(typeof results[0].intakeItemId).toBe("string");
  });

  it("rejects oversized batches without persisting", async () => {
    const response = await POST(
      postRequest("/api/intake/submit", {
        lines: Array.from({ length: 101 }, (_, i) => `not a url ${i}`),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("returns 503 when the database is not initialized", async () => {
    isolated.restoreEnv();
    process.env["APP_DATA_ROOT"] = `${isolated.root}-missing`;
    try {
      const response = await POST(postRequest("/api/intake/submit", { lines: [] }));
      expect(response.status).toBe(503);
    } finally {
      process.env["APP_DATA_ROOT"] = isolated.root;
    }
  });
});
