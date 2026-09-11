// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  computeBackoffMs,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_MAX_MS,
} from "../../../src/queue/backoff";

describe("queue backoff", () => {
  it("grows exponentially from the base delay", () => {
    expect(computeBackoffMs(1)).toBe(DEFAULT_BACKOFF_BASE_MS);
    expect(computeBackoffMs(2)).toBe(DEFAULT_BACKOFF_BASE_MS * 2);
    expect(computeBackoffMs(3)).toBe(DEFAULT_BACKOFF_BASE_MS * 4);
  });

  it("caps growth at the maximum delay", () => {
    expect(computeBackoffMs(99)).toBe(DEFAULT_BACKOFF_MAX_MS);
    expect(computeBackoffMs(4, { baseMs: 1000, maxMs: 5000 })).toBe(5000);
  });

  it("honors explicit bounds", () => {
    expect(computeBackoffMs(2, { baseMs: 250, maxMs: 10_000 })).toBe(500);
  });

  it("rejects non-positive attempt numbers and bounds", () => {
    expect(() => computeBackoffMs(0)).toThrow(RangeError);
    expect(() => computeBackoffMs(-2)).toThrow(RangeError);
    expect(() => computeBackoffMs(1.5)).toThrow(RangeError);
    expect(() => computeBackoffMs(1, { baseMs: -1 })).toThrow(RangeError);
    expect(() => computeBackoffMs(1, { maxMs: -1 })).toThrow(RangeError);
  });
});
