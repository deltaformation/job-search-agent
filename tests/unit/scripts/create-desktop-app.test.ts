// @vitest-environment node
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const NODE = process.execPath;
const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "create-desktop-app.mjs");

function runCli(args: string[]) {
  return spawnSync(NODE, [SCRIPT, ...args], {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    timeout: 30000,
  });
}

describe("create-desktop-app CLI validation", () => {
  it("prints usage for --help", () => {
    const result = runCli(["--help"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/usage: create-desktop-app\.mjs/);
  });

  it("rejects non-loopback hosts", () => {
    for (const host of ["evil.com", "0.0.0.0", "192.168.1.1"]) {
      const result = runCli(["--dry-run", "--host", host]);
      expect(result.status, host).not.toBe(0);
      expect(result.stderr).toMatch(/loopback-only/);
    }
  });

  it("rejects out-of-range and non-numeric ports", () => {
    const range = runCli(["--dry-run", "--port", "99999"]);
    expect(range.status, range.stderr).not.toBe(0);
    expect(range.stderr).toMatch(/between 1 and 65535/);
    const text = runCli(["--dry-run", "--port", "abc"]);
    expect(text.status, text.stderr).not.toBe(0);
    expect(text.stderr).toMatch(/must be an integer/);
  });

  it("rejects unknown server commands", () => {
    const result = runCli(["--dry-run", "--server-cmd=bogus"]);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toMatch(/auto, start, or dev/);
  });

  it("rejects unknown arguments", () => {
    const result = runCli(["--frobnicate"]);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toMatch(/unknown argument/);
  });

  it("generates Info.plist with arm64 LSArchitecturePriority", async () => {
    const { buildInfoPlist } = await import("../../../scripts/create-desktop-app.mjs");
    const plist = buildInfoPlist({ version: "1.1.0" });
    expect(plist).toContain("<key>LSArchitecturePriority</key>");
    expect(plist).toContain("<string>arm64</string>");
  });

  it("generates launcher with arm64 re-exec guard and Chrome isolation flags", async () => {
    const { buildLauncher } = await import("../../../scripts/create-desktop-app.mjs");
    const script = buildLauncher({
      nodeBin: "/usr/local/bin/node",
      nodeMajor: "24",
      projectDir: "/test/project",
      host: "127.0.0.1",
      port: 3000,
      serverCmd: "start",
    });
    expect(script).toContain("arch -arm64");
    expect(script).toContain("--disable-session-crashed-bubble");
    expect(script).toContain("--disable-background-networking");
    expect(script).toContain("--disable-component-update");
    expect(script).toContain("Sessions");
  });
});

