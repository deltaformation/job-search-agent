// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseVersionedPayload } from "../../../src/domain";

const parsers = {
  "widget-v1": z
    .object({ schemaVersion: z.literal("widget-v1"), name: z.string().min(1) })
    .strict(),
  "widget-v2": z
    .object({
      schemaVersion: z.literal("widget-v2"),
      name: z.string().min(1),
      retired: z.boolean(),
    })
    .strict(),
} as const;

describe("versioned payload envelopes", () => {
  it("routes payloads to their versioned schema", () => {
    expect(
      parseVersionedPayload(parsers, {
        schemaVersion: "widget-v1",
        name: "w",
      }),
    ).toEqual({
      ok: true,
      schemaVersion: "widget-v1",
      value: { schemaVersion: "widget-v1", name: "w" },
    });
    expect(
      parseVersionedPayload(parsers, {
        schemaVersion: "widget-v2",
        name: "w",
        retired: false,
      }),
    ).toMatchObject({ ok: true, schemaVersion: "widget-v2" });
  });

  it("rejects unknown versions instead of guessing", () => {
    expect(
      parseVersionedPayload(parsers, { schemaVersion: "widget-v9" }),
    ).toMatchObject({ ok: false, error: "unsupported-version" });
  });

  it("rejects malformed envelopes and payloads", () => {
    expect(parseVersionedPayload(parsers, null)).toMatchObject({
      ok: false,
      error: "invalid-envelope",
    });
    expect(parseVersionedPayload(parsers, [])).toMatchObject({
      ok: false,
      error: "invalid-envelope",
    });
    expect(parseVersionedPayload(parsers, { name: "no tag" })).toMatchObject({
      ok: false,
      error: "invalid-envelope",
    });
    expect(
      parseVersionedPayload(parsers, { schemaVersion: "widget-v1" }),
    ).toMatchObject({ ok: false, error: "invalid-payload" });
    expect(
      parseVersionedPayload(parsers, {
        schemaVersion: "widget-v1",
        name: "w",
        smuggled: 1,
      }),
    ).toMatchObject({ ok: false, error: "invalid-payload" });
  });
});
