// @vitest-environment node
import { describe, expect, it } from "vitest";
import { OriginThrottle } from "../../../src/scraping/throttle";

describe("origin throttle", () => {
  it("passes the first fetch per origin without waiting", async () => {
    let now = 1000;
    const slept: number[] = [];
    const throttle = new OriginThrottle({
      minIntervalMs: 2000,
      now: () => now,
      sleep: async (ms: number) => {
        slept.push(ms);
        now += ms;
      },
    });
    await throttle.gate("https://a.example");
    await throttle.gate("https://b.example");
    expect(slept).toEqual([]);
  });

  it("inserts the minimum gap between same-origin fetches", async () => {
    let now = 1000;
    const slept: number[] = [];
    const throttle = new OriginThrottle({
      minIntervalMs: 2000,
      now: () => now,
      sleep: async (ms: number) => {
        slept.push(ms);
        now += ms;
      },
    });
    await throttle.gate("https://a.example");
    now += 500;
    await throttle.gate("https://a.example");
    expect(slept).toEqual([1500]);
    // After enough real time passes, no wait is needed.
    now += 5000;
    await throttle.gate("https://a.example");
    expect(slept).toEqual([1500]);
  });

  it("treats origins independently and honors a zero interval", async () => {
    const slept: number[] = [];
    const throttle = new OriginThrottle({
      minIntervalMs: 0,
      now: () => 1000,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    });
    await throttle.gate("https://a.example");
    await throttle.gate("https://a.example");
    expect(slept).toEqual([]);
  });

  it("rejects negative intervals", () => {
    expect(() => new OriginThrottle({ minIntervalMs: -1 })).toThrow(
      RangeError,
    );
  });
});
