// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { GET as progressGET } from "../../../app/api/jobs/[id]/tailoring/generations/[requestId]/route";
import { POST as retryPOST } from "../../../app/api/jobs/[id]/tailoring/generations/[requestId]/retry/route";
import {
  getTailoringJob,
  newId,
  openDatabase,
  workItems,
  type DatabaseHandle,
} from "../../../src/db";
import { utcNow } from "../../../src/db/utils";
import {
  GenerationReply,
  ProgressReply,
  TailoringErrorBody,
  TAILORING_RETRY_SCHEMA_VERSION,
} from "../../../src/domain/tailoringWorkspace";
import { completeWorkItem } from "../../../src/queue/leases";
import { ProviderError } from "../../../src/tailoring/contract";
import { seedCrossProfileWorld } from "../acceptance-v1.2/world";
import {
  claimFRun,
  fHandler,
  F_T0,
  makeArtifactsDir,
  seedFRun,
  throwingProvider,
  type FSeededRun,
} from "../acceptance-v1.3/f-world";
import {
  getRequest,
  postRequest,
  readJson,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

/**
 * WO-1.3-F route leg: GET progress maps the read to 200/400/403/404,
 * POST retry maps R to 202/200/400/403/404/409/422 — all with strict
 * reply bodies. Service behavior lives in the F suites; this file
 * pins the HTTP boundary only.
 */

function routeParams(id: string, requestId: string) {
  return { params: Promise.resolve({ id, requestId }) };
}

describe("progress GET and retry POST routes", () => {
  let isolated: IsolatedRoot;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-v13-f-routes-");
  });

  afterEach(() => {
    isolated.restoreEnv();
    isolated.cleanup();
  });

  function dbPath(): string {
    return join(isolated.root, "job-tracker.sqlite");
  }

  /** One seeded world per test; routes reopen the same file. */
  async function seedTerminalNetwork(): Promise<{
    run: FSeededRun;
    jobId: string;
    attemptId: string;
  }> {
    const handle = openDatabase({ path: dbPath() });
    try {
      const world = seedCrossProfileWorld({
        handle,
        dir: isolated.root,
        dbPath: dbPath(),
        cleanup: () => {},
      });
      const run = seedFRun(handle, world);
      handle.db
        .update(workItems)
        .set({ maxAttempts: 1 })
        .where(eq(workItems.id, run.workItemId))
        .run();
      const first = claimFRun(handle, run.workItemId, { now: F_T0 });
      const failed = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider: throwingProvider(new ProviderError("NETWORK", "simulated outage")),
        clock: () => F_T0,
      })(first.context);
      completeWorkItem(
        handle,
        {
          workItemId: run.workItemId,
          leaseToken: first.claimed.leaseToken,
          attemptId: first.claimed.currentAttemptId,
          result: "FAILED",
          errorCode: failed.errorCode ?? null,
          errorDetail: failed.errorDetail ?? null,
        },
        { now: F_T0 },
      );
      return {
        run,
        jobId: run.basics.jobId,
        attemptId: first.claimed.currentAttemptId,
      };
    } finally {
      handle.close();
    }
  }

  function seedQueuedRun(): { run: FSeededRun; jobId: string } {
    const handle = openDatabase({ path: dbPath() });
    try {
      const world = seedCrossProfileWorld({
        handle,
        dir: isolated.root,
        dbPath: dbPath(),
        cleanup: () => {},
      });
      const run = seedFRun(handle, world);
      return { run, jobId: run.basics.jobId };
    } finally {
      handle.close();
    }
  }

  async function reopen<T>(fn: (handle: DatabaseHandle) => T | Promise<T>): Promise<T> {
    const handle = openDatabase({ path: dbPath() });
    try {
      return await fn(handle);
    } finally {
      handle.close();
    }
  }

  it("GET returns a strict ProgressReply for a queued run", async () => {
    const { run, jobId } = seedQueuedRun();
    const response = await progressGET(
      getRequest(`/api/jobs/${jobId}/tailoring/generations/${run.requestId}`),
      routeParams(jobId, run.requestId),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(ProgressReply.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ requestId: run.requestId, state: "QUEUED" });
  });

  it("GET rejects bad ids, foreign rows, and foreign hosts", async () => {
    const { run, jobId } = seedQueuedRun();
    const bad = await progressGET(
      getRequest(`/api/jobs/${jobId}/tailoring/generations/not-a-uuid`),
      routeParams(jobId, "not-a-uuid"),
    );
    expect(bad.status).toBe(400);
    expect(TailoringErrorBody.safeParse(await readJson(bad)).success).toBe(true);

    const missing = await progressGET(
      getRequest(`/api/jobs/${jobId}/tailoring/generations/${newId()}`),
      routeParams(jobId, newId()),
    );
    expect(missing.status).toBe(404);

    const foreign = await progressGET(
      getRequest(`/api/jobs/${jobId}/tailoring/generations/${run.requestId}`, {
        host: "evil.example:3000",
      }),
      routeParams(jobId, run.requestId),
    );
    expect(foreign.status).toBe(403);
  });

  it("POST retries 202, replays 200, and maps 404/409/400/403", async () => {
    const { run, jobId, attemptId } = await seedTerminalNetwork();
    const rowVersion = await reopen(
      (handle) => getTailoringJob(handle, jobId)?.rowVersion ?? -1,
    );
    const retryPath = `/api/jobs/${jobId}/tailoring/generations/${run.requestId}/retry`;
    const body = {
      schemaVersion: TAILORING_RETRY_SCHEMA_VERSION,
      observedAttemptId: attemptId,
      observedRowVersion: rowVersion,
    };

    const retried = await retryPOST(postRequest(retryPath, body), routeParams(jobId, run.requestId));
    expect(retried.status).toBe(202);
    const retriedBody = await readJson(retried);
    expect(GenerationReply.safeParse(retriedBody).success).toBe(true);
    expect(retriedBody).toMatchObject({
      requestId: run.requestId,
      status: "QUEUED",
      replayed: false,
    });

    const replayed = await retryPOST(postRequest(retryPath, body), routeParams(jobId, run.requestId));
    expect(replayed.status).toBe(200);
    expect(await readJson(replayed)).toMatchObject({ replayed: true });

    const unknownAttempt = await retryPOST(
      postRequest(retryPath, { ...body, observedAttemptId: newId() }),
      routeParams(jobId, run.requestId),
    );
    expect(unknownAttempt.status).toBe(404);

    // Finish the requeued work terminally again so the conflict leg
    // runs against FAILED (not replayable) state.
    const attemptB = await reopen(async (handle) => {
      // The route requeued with wall-clock backoff; clear it so the
      // test reclaims immediately.
      handle.db
        .update(workItems)
        .set({ nextRunAt: F_T0 })
        .where(eq(workItems.id, run.workItemId))
        .run();
      const now = utcNow();
      const second = claimFRun(handle, run.workItemId, { now });
      handle.db
        .update(workItems)
        .set({ maxAttempts: 2 })
        .where(eq(workItems.id, run.workItemId))
        .run();
      const failed = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider: throwingProvider(new ProviderError("NETWORK", "simulated outage")),
        clock: () => now,
      })(second.context);
      completeWorkItem(
        handle,
        {
          workItemId: run.workItemId,
          leaseToken: second.claimed.leaseToken,
          attemptId: second.claimed.currentAttemptId,
          result: "FAILED",
          errorCode: failed.errorCode ?? null,
          errorDetail: failed.errorDetail ?? null,
        },
        { now },
      );
      return second.claimed.currentAttemptId;
    });
    const freshRowVersion = await reopen(
      (handle) => getTailoringJob(handle, jobId)?.rowVersion ?? -1,
    );
    const conflict = await retryPOST(
      postRequest(retryPath, {
        ...body,
        observedAttemptId: attemptB,
        observedRowVersion: freshRowVersion + 50,
      }),
      routeParams(jobId, run.requestId),
    );
    expect(conflict.status).toBe(409);
    const conflictBody = await readJson(conflict);
    expect(TailoringErrorBody.safeParse(conflictBody).success).toBe(true);
    expect(conflictBody).toMatchObject({
      error: expect.objectContaining({ code: "JOB_CONFLICT" }),
    });

    const malformed = await retryPOST(
      postRequest(retryPath, { observedAttemptId: attemptId }),
      routeParams(jobId, run.requestId),
    );
    expect(malformed.status).toBe(400);

    const forged = await retryPOST(
      postRequest(retryPath, body, { host: "127.0.0.1:3000", origin: "http://evil.example:3000" }),
      routeParams(jobId, run.requestId),
    );
    expect(forged.status).toBe(403);
  });

  it("POST refuses a non-retryable terminal failure with 422", async () => {
    const handle = openDatabase({ path: dbPath() });
    let run: FSeededRun;
    let jobId: string;
    let staleAttemptId: string;
    try {
      const world = seedCrossProfileWorld({
        handle,
        dir: isolated.root,
        dbPath: dbPath(),
        cleanup: () => {},
      });
      run = seedFRun(handle, world);
      jobId = run.basics.jobId;
      const row = handle.db.select().from(workItems).where(eq(workItems.id, run.workItemId)).get();
      const payload = JSON.parse(String(row?.payloadJson)) as Record<string, unknown>;
      payload["inputHash"] = "f".repeat(64);
      handle.db
        .update(workItems)
        .set({ payloadJson: JSON.stringify(payload) })
        .where(eq(workItems.id, run.workItemId))
        .run();
      const first = claimFRun(handle, run.workItemId, { now: F_T0 });
      const outcome = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider: throwingProvider(new ProviderError("NETWORK", "unused")),
        clock: () => F_T0,
      })(first.context);
      completeWorkItem(
        handle,
        {
          workItemId: run.workItemId,
          leaseToken: first.claimed.leaseToken,
          attemptId: first.claimed.currentAttemptId,
          result: outcome.result,
          errorCode: outcome.errorCode ?? null,
          errorDetail: outcome.errorDetail ?? null,
        },
        { now: F_T0 },
      );
      staleAttemptId = first.claimed.currentAttemptId;
    } finally {
      handle.close();
    }
    const rowVersion = await reopen((h) => getTailoringJob(h, jobId)?.rowVersion ?? -1);
    const response = await retryPOST(
      postRequest(`/api/jobs/${jobId}/tailoring/generations/${run.requestId}/retry`, {
        schemaVersion: TAILORING_RETRY_SCHEMA_VERSION,
        observedAttemptId: staleAttemptId,
        observedRowVersion: rowVersion,
      }),
      routeParams(jobId, run.requestId),
    );
    expect(response.status).toBe(422);
    expect(await readJson(response)).toMatchObject({
      error: expect.objectContaining({ code: "RETRY_NOT_ALLOWED" }),
    });
  });
});
