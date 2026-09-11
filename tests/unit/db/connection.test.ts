// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  connectionStatus,
  DEFAULT_BUSY_TIMEOUT_MS,
  openDatabase,
} from "../../../src/db";

describe("openDatabase connection policy", () => {
  it("enables foreign keys, WAL, and the default busy timeout on file DBs", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-tracker-conn-"));
    try {
      const handle = openDatabase({ path: join(dir, "policy.sqlite") });
      try {
        expect(connectionStatus(handle.sqlite)).toEqual({
          foreignKeys: true,
          journalMode: "wal",
          busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
        });
      } finally {
        handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors an explicit bounded busy timeout", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-tracker-conn-"));
    try {
      const handle = openDatabase({
        path: join(dir, "timeout.sqlite"),
        busyTimeoutMs: 1234,
      });
      try {
        expect(connectionStatus(handle.sqlite).busyTimeoutMs).toBe(1234);
      } finally {
        handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects out-of-range busy timeouts before opening anything", () => {
    for (const busyTimeoutMs of [-1, 60001, 1.5, Number.NaN]) {
      expect(() =>
        openDatabase({ path: ":memory:", busyTimeoutMs }),
      ).toThrow(RangeError);
    }
  });

  it("creates missing parent directories for the database file", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-tracker-conn-"));
    try {
      const nested = join(dir, "a", "b", "nested.sqlite");
      const handle = openDatabase({ path: nested });
      handle.close();
      expect(existsSync(nested)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opens volatile in-memory databases with foreign keys on", () => {
    const handle = openDatabase({ path: ":memory:" });
    try {
      expect(connectionStatus(handle.sqlite).foreignKeys).toBe(true);
    } finally {
      handle.close();
    }
  });
});
