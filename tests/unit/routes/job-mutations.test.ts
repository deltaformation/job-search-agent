// @vitest-environment node
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, openDatabase } from "../../../src/db";
import { applications, jobNotes, jobs } from "../../../src/db/schema";
import { POST as correct } from "../../../app/api/jobs/[id]/correct/route";
import { POST as move } from "../../../app/api/jobs/[id]/move/route";
import { POST as addNote } from "../../../app/api/jobs/[id]/notes/route";
import { POST as reorder } from "../../../app/api/jobs/[id]/reorder/route";
import {
  postRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

describe("job mutation routes", () => {
  let isolated: IsolatedRoot;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-mutations-test-");
  });

  afterEach(() => {
    isolated.restoreEnv();
    isolated.cleanup();
  });

  function dbPath(): string {
    return join(isolated.root, "job-tracker.sqlite");
  }

  function seedJob(status: string, rowVersion = 1): string {
    const id = newId();
    const handle = openDatabase({ path: dbPath() });
    try {
      handle.db
        .insert(jobs)
        .values({ id, status, title: "Engineer", rank: 0, rowVersion })
        .run();
    } finally {
      handle.close();
    }
    return id;
  }

  function jobStatus(jobId: string): string | undefined {
    const handle = openDatabase({ path: dbPath() });
    try {
      return handle.db.select().from(jobs).all().find((row) => row.id === jobId)?.status;
    } finally {
      handle.close();
    }
  }

  it("gates mutations and rejects empty ids", async () => {
    const id = seedJob("NEW");
    const noOrigin = await move(
      postRequest(`/api/jobs/${id}/move`, { to: "REJECTED" }, { host: "127.0.0.1:3000", origin: "" }),
      routeParams(id),
    );
    expect(noOrigin.status).toBe(403);
    const empty = await move(
      postRequest("/api/jobs/%20/move", { to: "REJECTED" }),
      routeParams("   "),
    );
    expect(empty.status).toBe(400);
    const malformed = await move(
      postRequest("/api/jobs/not-a-uuid/move", { to: "REJECTED" }),
      routeParams("not-a-uuid"),
    );
    expect(malformed.status).toBe(400);
  });

  it("moves along the ordinary graph and records applications", async () => {
    const id = seedJob("TAILORED");
    const applied = await move(
      postRequest(`/api/jobs/${id}/move`, {
        to: "APPLIED",
        observedRowVersion: 1,
        appliedAt: "2026-09-11T09:00:00.000Z",
        confirmationNumber: "CONF-7",
      }),
      routeParams(id),
    );
    expect(applied.status).toBe(200);
    const appliedBody = await readJson(applied);
    expect(appliedBody["applicationId"]).toBeTypeOf("string");
    expect(jobStatus(id)).toBe("APPLIED");
    const handle = openDatabase({ path: dbPath() });
    try {
      const rows = handle.db.select().from(applications).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].confirmationNumber).toBe("CONF-7");
    } finally {
      handle.close();
    }

    const interviewed = await move(
      postRequest(`/api/jobs/${id}/move`, { to: "INTERVIEWED", observedRowVersion: 2 }),
      routeParams(id),
    );
    expect(interviewed.status).toBe(200);
    expect(jobStatus(id)).toBe("INTERVIEWED");
  });

  it("maps rule violations to 400 with machine codes", async () => {
    const id = seedJob("NEW");
    const cases: { payload: Record<string, unknown>; error: string }[] = [
      { payload: { to: "TAILORED", observedRowVersion: 1 }, error: "approval-required" },
      {
        payload: { to: "APPLIED", observedRowVersion: 1, appliedAt: "2026-09-11T09:00:00.000Z" },
        error: "correction-required",
      },
      { payload: { to: "REJECTED", observedRowVersion: 1 }, error: "reason-required" },
      { payload: { to: "APPLIED", observedRowVersion: 1 }, error: "application-data-required" },
    ];
    for (const { payload, error } of cases) {
      const response = await move(
        postRequest(`/api/jobs/${id}/move`, payload),
        routeParams(id),
      );
      expect(response.status).toBe(400);
      expect((await readJson(response))["error"]).toBe(error);
    }
    expect(jobStatus(id)).toBe("NEW");

    const missingId = newId();
    const missing = await move(
      postRequest(`/api/jobs/${missingId}/move`, { to: "REJECTED", observedRowVersion: 1, reason: "x" }),
      routeParams(missingId),
    );
    expect(missing.status).toBe(404);
  });

  it("returns conflicts with the current version for stale writers", async () => {
    const id = seedJob("TAILORED");
    const first = await move(
      postRequest(`/api/jobs/${id}/move`, {
        to: "APPLIED",
        observedRowVersion: 1,
        appliedAt: "2026-09-11T09:00:00.000Z",
      }),
      routeParams(id),
    );
    expect(first.status).toBe(200);
    const stale = await reorder(
      postRequest(`/api/jobs/${id}/reorder`, { rank: 9, observedRowVersion: 1 }),
      routeParams(id),
    );
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toMatchObject({ error: "conflict", currentRowVersion: 2 });
  });

  it("corrects with a mandatory note and keeps TAILORED gated", async () => {
    const id = seedJob("APPLIED");
    const reopened = await correct(
      postRequest(`/api/jobs/${id}/correct`, {
        to: "NEW",
        observedRowVersion: 1,
        note: "withdrew; starting over",
      }),
      routeParams(id),
    );
    expect(reopened.status).toBe(200);
    expect(jobStatus(id)).toBe("NEW");

    const gated = await correct(
      postRequest(`/api/jobs/${id}/correct`, {
        to: "TAILORED",
        observedRowVersion: 2,
        note: "trying to skip approval",
      }),
      routeParams(id),
    );
    expect(gated.status).toBe(400);
    expect((await readJson(gated))["error"]).toBe("approval-required");

    const noteless = await correct(
      postRequest(`/api/jobs/${id}/correct`, { to: "REJECTED", observedRowVersion: 2 }),
      routeParams(id),
    );
    expect(noteless.status).toBe(400);
  });

  it("reorders within a column and appends notes", async () => {
    const id = seedJob("NEW");
    const reordered = await reorder(
      postRequest(`/api/jobs/${id}/reorder`, { rank: 2.5, observedRowVersion: 1 }),
      routeParams(id),
    );
    expect(reordered.status).toBe(200);
    expect((await readJson(reordered))["moved"]).toBe(true);

    const noted = await addNote(
      postRequest(`/api/jobs/${id}/notes`, { body: "met the team" }),
      routeParams(id),
    );
    expect(noted.status).toBe(200);
    const handle = openDatabase({ path: dbPath() });
    try {
      const rows = handle.db.select().from(jobNotes).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].body).toBe("met the team");
      // Notes never bump the card version.
      expect(handle.db.select().from(jobs).all()[0].rowVersion).toBe(2);
    } finally {
      handle.close();
    }

    const empty = await addNote(
      postRequest(`/api/jobs/${id}/notes`, { body: "   " }),
      routeParams(id),
    );
    expect(empty.status).toBe(400);
  });
});
