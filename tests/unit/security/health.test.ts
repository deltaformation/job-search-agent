// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GET } from "../../../app/api/health/route";

const PREVIOUS = process.env.APP_DATA_ROOT;

afterEach(() => {
  if (PREVIOUS === undefined) {
    delete process.env.APP_DATA_ROOT;
  } else {
    process.env.APP_DATA_ROOT = PREVIOUS;
  }
});

describe("health route", () => {
  it("reports ok when storage and migrations are present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-tracker-health-"));
    try {
      mkdirSync(join(dir, "evidence"), { recursive: true });
      mkdirSync(join(dir, "artifacts"), { recursive: true });
      writeFileSync(join(dir, "job-tracker.sqlite"), "x");
      process.env.APP_DATA_ROOT = dir;
      const response = await GET();
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        status: string;
        migrations: { files: string[] };
      };
      expect(body.status).toBe("ok");
      expect(body.migrations.files.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports degraded when storage is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-tracker-health-"));
    try {
      process.env.APP_DATA_ROOT = join(dir, "absent");
      const response = await GET();
      expect(response.status).toBe(503);
      const body = (await response.json()) as { status: string };
      expect(body.status).toBe("degraded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
