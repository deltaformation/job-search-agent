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

  it("leaves the tailoring provider unconfigured by default", () => {
    expect(resolveWorkerConfig({}, "/repo", 1).tailorProvider).toBeNull();
    expect(
      resolveWorkerConfig({ TAILOR_PROVIDER_ARGV: "  " }, "/repo", 1).tailorProvider,
    ).toBeNull();
  });

  it("parses the tailoring provider command and limits", () => {
    const config = resolveWorkerConfig(
      {
        TAILOR_PROVIDER_ARGV: JSON.stringify(["/usr/local/bin/tailor", "--mode", "propose"]),
        TAILOR_PROVIDER_TIMEOUT_MS: "60000",
        TAILOR_PROVIDER_MAX_OUTPUT_BYTES: "65536",
        TAILOR_PROVIDER_MODEL: "local-1",
      },
      "/repo",
      1,
    );
    expect(config.tailorProvider).toEqual({
      argv: ["/usr/local/bin/tailor", "--mode", "propose"],
      timeoutMs: 60_000,
      maxOutputBytes: 65_536,
      model: "local-1",
    });
  });

  it("defaults provider limits and model", () => {
    const config = resolveWorkerConfig(
      { TAILOR_PROVIDER_ARGV: JSON.stringify(["/bin/agent"]) },
      "/repo",
      1,
    );
    expect(config.tailorProvider).toEqual({
      argv: ["/bin/agent"],
      timeoutMs: 120_000,
      maxOutputBytes: 262_144,
      model: null,
    });
  });

  it("rejects invalid provider configuration", () => {
    expect(() =>
      resolveWorkerConfig({ TAILOR_PROVIDER_ARGV: "not-json" }, "/repo", 1),
    ).toThrow(/TAILOR_PROVIDER_ARGV/);
    expect(() =>
      resolveWorkerConfig({ TAILOR_PROVIDER_ARGV: JSON.stringify({ exe: "x" }) }, "/repo", 1),
    ).toThrow(/TAILOR_PROVIDER_ARGV/);
    expect(() =>
      resolveWorkerConfig({ TAILOR_PROVIDER_ARGV: JSON.stringify([]) }, "/repo", 1),
    ).toThrow(/TAILOR_PROVIDER_ARGV/);
    expect(() =>
      resolveWorkerConfig({ TAILOR_PROVIDER_ARGV: JSON.stringify(["ok", 7]) }, "/repo", 1),
    ).toThrow(/TAILOR_PROVIDER_ARGV/);
    expect(() =>
      resolveWorkerConfig(
        {
          TAILOR_PROVIDER_ARGV: JSON.stringify(["/bin/agent"]),
          TAILOR_PROVIDER_TIMEOUT_MS: "0",
        },
        "/repo",
        1,
      ),
    ).toThrow(/TAILOR_PROVIDER_TIMEOUT_MS/);
    expect(() =>
      resolveWorkerConfig(
        {
          TAILOR_PROVIDER_ARGV: JSON.stringify(["/bin/agent"]),
          TAILOR_PROVIDER_MAX_OUTPUT_BYTES: "512",
        },
        "/repo",
        1,
      ),
    ).toThrow(/TAILOR_PROVIDER_MAX_OUTPUT_BYTES/);
  });
});
