// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveWorkerConfig } from "../../../src/worker/config";

describe("worker configuration", () => {
  it("derives storage, loopback, and identity defaults", () => {
    const config = resolveWorkerConfig({}, "/repo", 4242);
    expect(config).toMatchObject({
      workerId: "worker-4242",
      host: "127.0.0.1",
      port: 3000,
    });
    expect(config.databasePath).toContain("job-tracker.sqlite");
  });

  it("honors explicit worker identity and data root", () => {
    const config = resolveWorkerConfig(
      { WORKER_ID: "worker-blue", APP_DATA_ROOT: "/data/blue" },
      "/repo",
      1,
    );
    expect(config.workerId).toBe("worker-blue");
    expect(config.root).toBe("/data/blue");
  });
});
