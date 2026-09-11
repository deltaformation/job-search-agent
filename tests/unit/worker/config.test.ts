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

  it("defaults dispatch timing knobs", () => {
    const config = resolveWorkerConfig({}, "/repo", 4242);
    expect(config).toMatchObject({
      leaseDurationMs: 300_000,
      pollIntervalMs: 1000,
    });
  });

  it("defaults the browser registry under the repository", () => {
    expect(resolveWorkerConfig({}, "/repo", 1).playwrightBrowsersPath).toBe(
      "/repo/.playwright-browsers",
    );
    expect(
      resolveWorkerConfig(
        { PLAYWRIGHT_BROWSERS_PATH: "/browsers" },
        "/repo",
        1,
      ).playwrightBrowsersPath,
    ).toBe("/browsers");
  });

  it("honors explicit dispatch timing", () => {
    const config = resolveWorkerConfig(
      { WORKER_LEASE_MS: "60000", WORKER_POLL_MS: "250" },
      "/repo",
      1,
    );
    expect(config).toMatchObject({
      leaseDurationMs: 60_000,
      pollIntervalMs: 250,
    });
  });

  it("rejects invalid dispatch timing", () => {
    expect(() =>
      resolveWorkerConfig({ WORKER_LEASE_MS: "0" }, "/repo", 1),
    ).toThrow(/WORKER_LEASE_MS/);
    expect(() =>
      resolveWorkerConfig({ WORKER_LEASE_MS: "soon" }, "/repo", 1),
    ).toThrow(/WORKER_LEASE_MS/);
    expect(() =>
      resolveWorkerConfig({ WORKER_LEASE_MS: "99999999" }, "/repo", 1),
    ).toThrow(/WORKER_LEASE_MS/);
    expect(() =>
      resolveWorkerConfig({ WORKER_POLL_MS: "-5" }, "/repo", 1),
    ).toThrow(/WORKER_POLL_MS/);
  });
});
