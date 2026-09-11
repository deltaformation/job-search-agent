// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as getToken } from "../../../app/api/intake/clip-token/route";
import { OPTIONS, POST as clip } from "../../../app/api/intake/clip/route";
import {
  getRequest,
  readJson,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

const FIXTURE_HTML = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "extraction",
    "fixtures",
    "jobposting-jsonld.html",
  ),
  "utf8",
);
const CLIP_URL = "https://example.com/jobs/clip-route";

function clipRequest(
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request("http://127.0.0.1:3000/api/intake/clip", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: "https://boards.example",
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

describe("clip token display", () => {
  let isolated: IsolatedRoot;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-clip-token-test-");
  });

  afterEach(() => {
    isolated.restoreEnv();
    isolated.cleanup();
  });

  it("issues a stable token to same-origin readers only", async () => {
    const first = await getToken(getRequest("/api/intake/clip-token"));
    expect(first.status).toBe(200);
    const firstBody = await readJson(first);
    expect(firstBody["token"]).toMatch(/^[0-9a-f]{64}$/);
    const second = await getToken(getRequest("/api/intake/clip-token"));
    expect((await readJson(second))["token"]).toBe(firstBody["token"]);
    // No CORS headers: remote websites cannot read the token.
    expect(first.headers.get("access-control-allow-origin")).toBeNull();

    const rebound = await getToken(
      getRequest("/api/intake/clip-token", { host: "evil.example:3000" }),
    );
    expect(rebound.status).toBe(403);
  });
});

describe("POST /api/intake/clip", () => {
  let isolated: IsolatedRoot;
  let token: string;

  beforeEach(async () => {
    isolated = setupIsolatedRoot("job-tracker-clip-test-");
    const response = await getToken(getRequest("/api/intake/clip-token"));
    token = String((await readJson(response))["token"]);
  });

  afterEach(() => {
    isolated.restoreEnv();
    isolated.cleanup();
  });

  function authed(body: unknown): Request {
    return clipRequest(body, { authorization: `Bearer ${token}` });
  }

  it("answers CORS preflights without auth", async () => {
    const response = await OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "authorization",
    );
  });

  it("rejects missing, malformed, and wrong tokens", async () => {
    const body = { url: CLIP_URL, html: "<p>x</p>" };
    const cases: Record<string, string>[] = [
      {},
      { authorization: "Bearer short" },
      { authorization: "Token x" },
      { authorization: `Bearer ${"0".repeat(64)}` },
    ];
    for (const headers of cases) {
      const response = await clip(clipRequest(body, headers));
      expect(response.status).toBe(401);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }
  });

  it("ingests a clipped DOM end to end, then dedupes", async () => {
    const first = await clip(
      authed({ url: CLIP_URL, html: FIXTURE_HTML, title: "Staff Engineer" }),
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("access-control-allow-origin")).toBe("*");
    const created = await readJson(first);
    expect(created["outcome"]).toBe("created");
    expect(created["jobId"]).toBeTypeOf("string");

    const second = await clip(
      authed({ url: CLIP_URL, html: FIXTURE_HTML }),
    );
    expect(second.status).toBe(200);
    const duplicate = await readJson(second);
    expect(duplicate).toMatchObject({
      outcome: "duplicate",
      jobId: created["jobId"],
    });
  });

  it("returns reason-coded rejections with CORS headers", async () => {
    const invalid = await clip(authed({ url: "not a url", html: "<p>x</p>" }));
    expect(invalid.status).toBe(200);
    const body = await readJson(invalid);
    expect(body).toMatchObject({ outcome: "rejected", reasonCode: "INVALID_URL" });
    expect(invalid.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("rejects malformed bodies and oversized pages", async () => {
    const malformed = await clip(
      new Request("http://127.0.0.1:3000/api/intake/clip", {
        method: "POST",
        headers: {
          host: "127.0.0.1:3000",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: "{oops",
      }),
    );
    expect(malformed.status).toBe(400);

    const missing = await clip(authed({ url: CLIP_URL }));
    expect(missing.status).toBe(400);

    const huge = await clip(authed({ url: CLIP_URL, html: "x".repeat(5_000_001) }));
    expect(huge.status).toBe(413);
  });
});
