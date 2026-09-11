// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  parseHost,
  parsePort,
  resolveRuntimeConfig,
} from "../../../src/security";

describe("runtime configuration", () => {
  it("defaults to loopback port 3000", () => {
    expect(parsePort(undefined)).toBe(3000);
    expect(parsePort("")).toBe(3000);
    expect(parsePort("4000")).toBe(4000);
    expect(parseHost(undefined)).toBe("127.0.0.1");
    expect(parseHost("localhost")).toBe("localhost");
    expect(parseHost("LOCALHOST")).toBe("localhost");
  });

  it("rejects invalid ports and non-loopback hosts", () => {
    for (const bad of ["0", "65536", "-1", "3.5", "http", "3000x"]) {
      expect(() => parsePort(bad), bad).toThrow(/PORT/);
    }
    for (const bad of ["0.0.0.0", "example.com", "192.168.1.2", "::1"]) {
      expect(() => parseHost(bad), bad).toThrow(/loopback/);
    }
  });

  it("resolves the full config from environment", () => {
    const config = resolveRuntimeConfig(
      { APP_DATA_ROOT: "/data/x", PORT: "4001", HOST: "localhost" },
      "/repo",
    );
    expect(config).toMatchObject({
      root: "/data/x",
      host: "localhost",
      port: 4001,
    });
    expect(config.databasePath).toContain("job-tracker.sqlite");
  });
});
