// @vitest-environment node
import { describe, expect, it } from "vitest";
import { POST } from "../../../app/api/intake/prepare/route";
import { mutationHeaders, postRequest, readJson } from "./_helpers";

/**
 * Prepare is DNS-live but deterministic for reserved inputs: `.test`
 * hostnames never resolve (INVALID) and malformed lines never reach DNS.
 * ENQUEUED/DUPLICATE paths need resolving DNS and stay covered at the
 * service level with injected resolvers (intake.test.ts).
 */

describe("POST /api/intake/prepare", () => {
  it("rejects forged hosts, origins, and missing metadata", async () => {
    const badHost = await POST(
      postRequest("/api/intake/prepare", { lines: [] }, {
        ...mutationHeaders(),
        host: "evil.example:3000",
      }),
    );
    expect(badHost.status).toBe(403);
    const badOrigin = await POST(
      postRequest("/api/intake/prepare", { lines: [] }, {
        ...mutationHeaders(),
        origin: "http://evil.example:3000",
      }),
    );
    expect(badOrigin.status).toBe(403);
    const missing = await POST(
      postRequest("/api/intake/prepare", { lines: [] }, { host: "127.0.0.1:3000" }),
    );
    expect(missing.status).toBe(403);
  });

  it("accepts same-origin fetch metadata without an Origin header", async () => {
    const response = await POST(
      postRequest("/api/intake/prepare", { lines: [] }, {
        host: "127.0.0.1:3000",
        "sec-fetch-site": "same-origin",
      }),
    );
    expect(response.status).toBe(200);
  });

  it("rejects malformed bodies and oversized batches", async () => {
    const malformed = await POST(
      new Request("http://127.0.0.1:3000/api/intake/prepare", {
        method: "POST",
        headers: { ...mutationHeaders(), "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(malformed.status).toBe(400);
    const schema = await POST(postRequest("/api/intake/prepare", { lines: "nope" }));
    expect(schema.status).toBe(400);
    const tooLarge = await POST(
      postRequest("/api/intake/prepare", {
        lines: Array.from({ length: 101 }, (_, i) => `not a url ${i}`),
      }),
    );
    expect(tooLarge.status).toBe(400);
    expect(((await readJson(tooLarge))["reason"] as string) ?? "").toContain("100");
  });

  it("classifies lines without persisting", async () => {
    const response = await POST(
      postRequest("/api/intake/prepare", {
        lines: ["not a url", "https://jobs.test/posting/1", ""],
      }),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    const results = body["results"] as Array<{
      lineNumber: number;
      outcome: string;
      reasonCode: string | null;
      canonicalUrl: string | null;
    }>;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ lineNumber: 1, outcome: "INVALID" });
    expect(results[1]).toMatchObject({
      lineNumber: 2,
      outcome: "INVALID",
      reasonCode: "INVALID_URL",
      canonicalUrl: "https://jobs.test/posting/1",
    });
  });
});
