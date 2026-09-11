// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createLogger, flushStdio } from "../../../src/security";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const logger = createLogger("test", {
    sinks: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
    now: () => "2026-09-11T00:00:00.000Z",
  });
  return { out, err, logger };
}

describe("structured logger", () => {
  it("emits one JSON line per call with redacted fields", () => {
    const { out, err, logger } = capture();
    logger.info("job queued", { jobId: "j1", apiToken: "sk-live" });
    logger.error("failed", { reason: "TIMEOUT" });
    expect(out).toHaveLength(1);
    expect(err).toHaveLength(1);
    expect(JSON.parse(out[0])).toEqual({
      ts: "2026-09-11T00:00:00.000Z",
      level: "info",
      component: "test",
      msg: "job queued",
      fields: { jobId: "j1", apiToken: "[REDACTED]" },
    });
    expect(JSON.parse(err[0])).toMatchObject({ level: "error" });
  });

  it("omits the fields key when no fields are given", () => {
    const { out, err, logger } = capture();
    logger.warn("disk nearly full");
    expect(out).toHaveLength(0);
    expect(JSON.parse(err[0])).toEqual({
      ts: "2026-09-11T00:00:00.000Z",
      level: "warn",
      component: "test",
      msg: "disk nearly full",
    });
  });

  it("filters below the minimum level", () => {
    const out: string[] = [];
    const logger = createLogger("test", {
      level: "warn",
      sinks: { out: (line) => out.push(line), err: (line) => out.push(line) },
    });
    logger.debug("nope");
    logger.info("nope");
    logger.warn("yes");
    expect(out).toHaveLength(1);
  });

  it("flushes stdio without rejecting", async () => {
    await expect(flushStdio()).resolves.toBeUndefined();
  });
});
