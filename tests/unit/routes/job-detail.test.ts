// @vitest-environment node
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, openDatabase } from "../../../src/db";
import { jobNotes, jobs } from "../../../src/db/schema";
import { GET } from "../../../app/api/jobs/[id]/route";
import {
  getRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

describe("GET /api/jobs/[id]", () => {
  let isolated: IsolatedRoot;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-job-detail-test-");
  });

  afterEach(() => {
    isolated.restoreEnv();
    isolated.cleanup();
  });

  function seedJobWithNote(): string {
    const id = newId();
    const handle = openDatabase({
      path: join(isolated.root, "job-tracker.sqlite"),
    });
    try {
      handle.db
        .insert(jobs)
        .values({ id, status: "NEW", title: "Engineer", rank: 0, rowVersion: 1 })
        .run();
      handle.db.insert(jobNotes).values({ id: newId(), jobId: id, body: "hi" }).run();
    } finally {
      handle.close();
    }
    return id;
  }

  it("rejects rebinding hosts, empty ids, and unknown jobs", async () => {
    const rebound = await GET(
      getRequest("/api/jobs/x", { host: "evil.example:3000" }),
      routeParams("x"),
    );
    expect(rebound.status).toBe(403);
    const empty = await GET(getRequest("/api/jobs/%20"), routeParams("   "));
    expect(empty.status).toBe(400);
    const missing = await GET(
      getRequest("/api/jobs/does-not-exist"),
      routeParams("does-not-exist"),
    );
    expect(missing.status).toBe(404);
  });

  it("returns the complete safe detail shape", async () => {
    const jobId = seedJobWithNote();
    const response = await GET(
      getRequest(`/api/jobs/${jobId}`),
      routeParams(jobId),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(Object.keys(body).sort()).toEqual([
      "application",
      "artifacts",
      "attempts",
      "compensationHighlights",
      "extraction",
      "history",
      "intake",
      "job",
      "notes",
      "resumes",
      "source",
      "tailoringAttempt",
      "topKeywords",
    ]);
    const job = body["job"] as Record<string, unknown>;
    expect(job).toMatchObject({ id: jobId, title: "Engineer", rowVersion: 1 });
    const notes = body["notes"] as { body: string }[];
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("relativePath");
  });
});
