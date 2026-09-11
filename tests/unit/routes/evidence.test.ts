// @vitest-environment node
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  newId,
  openDatabase,
  scrapeAttempts,
  sourceArtifacts,
} from "../../../src/db";
import { storeEvidence } from "../../../src/scraping/evidence";
import { GET } from "../../../app/api/evidence/[id]/route";
import {
  getRequest,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

const T0 = "2026-09-11T12:00:00.000Z";

describe("GET /api/evidence/[id]", () => {
  let isolated: IsolatedRoot;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-evidence-test-");
  });

  afterEach(() => {
    isolated.restoreEnv();
    isolated.cleanup();
  });

  function insertArtifact(
    relativePath: string,
    mediaType = "text/html",
  ): string {
    const id = newId();
    const attemptId = newId();
    const handle = openDatabase({
      path: join(isolated.root, "job-tracker.sqlite"),
    });
    try {
      handle.db
        .insert(scrapeAttempts)
        .values({
          id: attemptId,
          canonicalUrl: "https://example.com/jobs/1",
          startedAt: T0,
          finishedAt: T0,
          outcome: "SUCCEEDED",
          workerId: "worker-a",
        })
        .run();
      handle.db
        .insert(sourceArtifacts)
        .values({
          id,
          scrapeAttemptId: attemptId,
          kind: "HTML",
          relativePath,
          mediaType,
          byteSize: 4,
          sha256: "a".repeat(64),
        })
        .run();
    } finally {
      handle.close();
    }
    return id;
  }

  it("rejects rebinding hosts and unknown ids", async () => {
    const forbidden = await GET(
      getRequest("/api/evidence/x", { host: "evil.example:3000" }),
      routeParams("x"),
    );
    expect(forbidden.status).toBe(403);
    const missing = await GET(
      getRequest("/api/evidence/does-not-exist"),
      routeParams("does-not-exist"),
    );
    expect(missing.status).toBe(404);
  });

  it("serves bytes with hostile-content headers", async () => {
    const bytes = Buffer.from("<h1>x</h1>", "utf8");
    const stored = storeEvidence(join(isolated.root, "evidence"), "HTML", bytes);
    const id = insertArtifact(stored.relativePath);
    const response = await GET(
      getRequest(`/api/evidence/${id}`),
      routeParams(id),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>x</h1>");
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("content-disposition")).toBeNull();
    const download = await GET(
      getRequest(`/api/evidence/${id}?download=1`),
      routeParams(id),
    );
    expect(download.headers.get("content-disposition")).toContain("attachment");
  });

  it("refuses escaped paths and missing bytes", async () => {
    const evil = insertArtifact("../escape.html");
    const rejected = await GET(
      getRequest(`/api/evidence/${evil}`),
      routeParams(evil),
    );
    expect(rejected.status).toBe(500);
    const ghost = insertArtifact(`ab/${"b".repeat(64)}.txt`);
    const missing = await GET(
      getRequest(`/api/evidence/${ghost}`),
      routeParams(ghost),
    );
    expect(missing.status).toBe(500);
  });
});
