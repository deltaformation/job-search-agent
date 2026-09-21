// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWorkerStatus,
  readWorkerStatus,
  workerStatusPath,
  writeWorkerStatus,
} from "../../../src/worker/status";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "job-tracker-worker-status-"));
  roots.push(root);
  return root;
}

describe("worker provider status", () => {
  it("round-trips provider identity without key material", () => {
    const root = tempRoot();
    const status = buildWorkerStatus({
      env: {
        ACTIVE_AI_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "synthetic-worker-key",
        OPENROUTER_MODEL: "draft-primary",
      },
      workerId: "worker-1",
      startedAt: "2026-09-14T00:00:00.000Z",
      tailorConfigured: true,
    });
    expect(status).toMatchObject({
      schemaVersion: "worker-status/v1",
      provider: "openrouter",
      models: { primary: "draft-primary", fallback: "nvidia/nemotron-3.5-lightning:free" },
      keyConfigured: true,
      tailorConfigured: true,
    });
    expect(status.keyFingerprint).toMatch(/^[0-9a-f]{8}$/);
    writeWorkerStatus(root, status);
    expect(readFileSync(workerStatusPath(root), "utf8")).not.toContain("synthetic-worker-key");
    expect(readWorkerStatus(root)).toEqual(status);
  });

  it("reports an unconfigured key honestly", () => {
    const root = tempRoot();
    writeWorkerStatus(
      root,
      buildWorkerStatus({
        env: { ACTIVE_AI_PROVIDER: "google" },
        workerId: "worker-1",
        startedAt: "2026-09-14T00:00:00.000Z",
        tailorConfigured: false,
      }),
    );
    expect(readWorkerStatus(root)).toMatchObject({
      provider: "google",
      keyConfigured: false,
      keyFingerprint: null,
      tailorConfigured: false,
    });
  });

  it("reads missing or corrupt status as unknown, never a guess", () => {
    const root = tempRoot();
    expect(readWorkerStatus(root)).toBeNull();
    writeFileSync(workerStatusPath(root), "{not json", "utf8");
    expect(readWorkerStatus(root)).toBeNull();
    writeFileSync(workerStatusPath(root), JSON.stringify({ schemaVersion: "wrong" }), "utf8");
    expect(readWorkerStatus(root)).toBeNull();
  });
});
