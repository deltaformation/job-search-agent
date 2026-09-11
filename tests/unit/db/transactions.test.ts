// @vitest-environment node
import { describe, expect, it } from "vitest";
import { jobs, newId, withTransaction } from "../../../src/db";
import { runWithTestDb } from "./helpers";

describe("withTransaction", () => {
  it("commits the callback result", () => {
    runWithTestDb((t) => {
      const id = newId();
      const returned = withTransaction(t.handle.sqlite, () => {
        t.handle.db.insert(jobs).values({ id }).run();
        return "ok";
      });
      expect(returned).toBe("ok");
      const rows = t.handle.sqlite
        .prepare("SELECT id FROM jobs WHERE id = ?")
        .all(id) as Array<{ id: string }>;
      expect(rows).toHaveLength(1);
    });
  });

  it("rolls back when the callback throws", () => {
    runWithTestDb((t) => {
      const id = newId();
      expect(() =>
        withTransaction(t.handle.sqlite, () => {
          t.handle.db.insert(jobs).values({ id }).run();
          throw new Error("boom");
        }),
      ).toThrow("boom");
      const rows = t.handle.sqlite
        .prepare("SELECT id FROM jobs WHERE id = ?")
        .all(id) as Array<{ id: string }>;
      expect(rows).toHaveLength(0);
    });
  });

  it("nests safely and rolls back the whole unit on inner failure", () => {
    runWithTestDb((t) => {
      const outerId = newId();
      const innerId = newId();
      expect(() =>
        withTransaction(t.handle.sqlite, () => {
          t.handle.db.insert(jobs).values({ id: outerId }).run();
          withTransaction(t.handle.sqlite, () => {
            t.handle.db.insert(jobs).values({ id: innerId }).run();
            throw new Error("inner boom");
          });
        }),
      ).toThrow("inner boom");
      const rows = t.handle.sqlite
        .prepare("SELECT id FROM jobs")
        .all() as Array<{ id: string }>;
      expect(rows).toHaveLength(0);
    });
  });
});
