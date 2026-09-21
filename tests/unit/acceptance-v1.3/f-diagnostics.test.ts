// @vitest-environment node
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { generationProgressEvents, workAttempts } from "../../../src/db";
import { getGenerationRequest } from "../../../src/db/generation";
import { CommandProvider } from "../../../src/tailoring/commandAdapter";
import { completeWorkItem } from "../../../src/queue/leases";
import { readGenerationProgress } from "../../../src/server/progress";
import {
  claimFRun,
  fHandler,
  F_T0,
  makeArtifactsDir,
  seedFRun,
  throwingProvider,
  withFDatabase,
} from "./f-world";

/**
 * WO-1.3-F secret-safety leg (F9): stderr, thrown messages, argv, and
 * paths never reach persisted details, progress replies, or copied
 * diagnostics. The UI allowlist itself is pinned exact-text in
 * `f-step3.test.tsx`; this file proves nothing secretable ever
 * arrives at that boundary.
 */

const SECRET_KEY = "sk-f9-live-provider-key-9f8e7d6c5b";
const SECRET_COT = "f9-chain-of-thought: consider fabricating tenure";
const SECRET_PATH = "/Users/f9-operator/.config/provider/credentials.json";

describe("F9: secrets never persist or serialize", () => {
  it("discards sidecar stderr across mapped exits", async () => {
    for (const exit of [3, 13, 14]) {
      const provider = new CommandProvider({
        argv: [
          process.execPath,
          "-e",
          `process.stderr.write(${JSON.stringify(`${SECRET_KEY}\n${SECRET_COT}\n${SECRET_PATH}\n`)});process.exit(${exit})`,
        ],
        timeoutMs: 30_000,
      });
      const outcome = await provider
        .prepare({
          schemaVersion: "tailor-input/v2",
          promptVersion: "tailor-prompt/v2",
          jdSnapshotId: "jd",
          jdText: "desc",
          candidateSnapshotId: "snap",
          profile: {},
          steering: {},
          selectedKeywords: [],
        } as never)
        .then(
          () => {
            throw new Error(`exit ${exit} unexpectedly succeeded`);
          },
          (error: unknown) => error as { reason?: unknown; detail?: string },
        );
      expect(outcome.detail ?? "").not.toContain(SECRET_KEY);
      expect(outcome.detail ?? "").not.toContain(SECRET_COT);
      expect(outcome.detail ?? "").not.toContain(SECRET_PATH);
      expect(outcome.detail ?? "").not.toContain(process.execPath);
    }
  });

  it("keeps thrown messages out of every persisted and serialized surface", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const { claimed, context } = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const outcome = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider: throwingProvider(
          new Error(`adapter bug leaking ${SECRET_KEY} via ${SECRET_PATH}: ${SECRET_COT}`),
        ),
        clock: () => F_T0,
      })(context);
      expect(outcome).toMatchObject({ result: "FAILED", errorCode: "INTERNAL" });

      // The handler returns the outcome; completion persists it. Sweep
      // both the outcome bytes and the rows the read path serves.
      completeWorkItem(
        t.handle,
        {
          workItemId: run.workItemId,
          leaseToken: claimed.leaseToken,
          attemptId: claimed.currentAttemptId,
          result: "FAILED",
          errorCode: outcome.errorCode ?? null,
          errorDetail: outcome.errorDetail ?? null,
        },
        { now: F_T0 },
      );
      const stored = t.handle.db
        .select()
        .from(workAttempts)
        .where(eq(workAttempts.id, claimed.currentAttemptId))
        .get();
      const request = getGenerationRequest(t.handle, run.requestId);
      const events = t.handle.db
        .select()
        .from(generationProgressEvents)
        .where(eq(generationProgressEvents.requestId, run.requestId))
        .all();
      const progress = readGenerationProgress(t.handle, {
        jobId: run.basics.jobId,
        requestId: run.requestId,
        now: "2026-09-16T12:00:17.000Z",
      });
      const surfaces = [
        outcome.errorDetail ?? "",
        stored?.errorCode ?? "",
        stored?.errorDetail ?? "",
        request?.errorCode ?? "",
        request?.errorDetail ?? "",
        JSON.stringify(events),
        progress.ok ? JSON.stringify(progress.reply) : "progress-failed",
      ];
      for (const surface of surfaces) {
        expect(surface).not.toContain(SECRET_KEY);
        expect(surface).not.toContain(SECRET_COT);
        expect(surface).not.toContain(SECRET_PATH);
      }
      expect(progress.ok).toBe(true);
    });
  });

  it("exposes no free-text channel on the reply or its events", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const progress = readGenerationProgress(t.handle, {
        jobId: run.basics.jobId,
        requestId: run.requestId,
        now: "2026-09-16T12:00:17.000Z",
      });
      expect(progress.ok).toBe(true);
      if (!progress.ok) {
        return;
      }
      expect(Object.keys(progress.reply).sort()).toEqual(
        [
          "attemptId",
          "events",
          "failure",
          "finishedAt",
          "lastHeartbeatAt",
          "leaseExpiresAt",
          "ok",
          "requestId",
          "resumeVersionId",
          "retryAllowed",
          "serverNow",
          "startedAt",
          "state",
        ].sort(),
      );
      for (const event of progress.reply.events) {
        expect(Object.keys(event).sort()).toEqual(
          ["recordedAt", "seq", "source", "stage"].sort(),
        );
      }
    });
  });
});
