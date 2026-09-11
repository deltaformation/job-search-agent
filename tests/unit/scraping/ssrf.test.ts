// @vitest-environment node
import { describe, expect, it } from "vitest";
import { classifyIp, preflightHost } from "../../../src/scraping";

describe("IP classification", () => {
  it("admits ordinary public addresses", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "172.15.0.1",
      "172.32.0.1",
      "100.128.0.1",
      "198.20.0.1",
      "2001:4860:4860::8888",
      "2606:4700:4700::1111",
    ]) {
      expect(classifyIp(ip), ip).toEqual({ blocked: false });
    }
  });

  it("blocks loopback, private, and link-local ranges", () => {
    const cases: Array<[string, string]> = [
      ["127.0.0.1", "loopback"],
      ["127.1.2.3", "loopback"],
      ["::1", "loopback"],
      ["10.0.0.1", "private"],
      ["172.16.0.1", "private"],
      ["172.31.255.255", "private"],
      ["192.168.1.1", "private"],
      ["fc00::1", "private"],
      ["fd12:3456::1", "private"],
      ["169.254.169.254", "link-local"],
      ["fe80::1", "link-local"],
      ["FE80::1", "link-local"],
    ];
    for (const [ip, category] of cases) {
      expect(classifyIp(ip), ip).toEqual({ blocked: true, category });
    }
  });

  it("blocks multicast, reserved, and special-use ranges", () => {
    const cases: Array<[string, string]> = [
      ["224.0.0.1", "multicast"],
      ["239.255.255.255", "multicast"],
      ["ff02::1", "multicast"],
      ["255.255.255.255", "reserved"],
      ["240.0.0.1", "reserved"],
      ["0.0.0.0", "reserved"],
      ["::", "unspecified"],
      ["100.64.0.1", "reserved"],
      ["100.127.255.255", "reserved"],
      ["192.0.2.1", "reserved"],
      ["198.51.100.7", "reserved"],
      ["203.0.113.9", "reserved"],
      ["192.0.0.1", "reserved"],
      ["192.88.99.1", "reserved"],
      ["198.18.0.1", "reserved"],
      ["2001:db8::1", "reserved"],
      ["100::abcd", "reserved"],
    ];
    for (const [ip, category] of cases) {
      expect(classifyIp(ip), ip).toEqual({ blocked: true, category });
    }
  });

  it("unpacks embedded IPv4 from transition mechanisms", () => {
    // IPv4-mapped: inner address decides.
    expect(classifyIp("::ffff:127.0.0.1")).toEqual({
      blocked: true,
      category: "loopback",
    });
    expect(classifyIp("::ffff:8.8.8.8")).toEqual({ blocked: false });
    // 6to4 2002:V4ADDR::/48: inner address decides.
    expect(classifyIp("2002:7f00:0001::1")).toEqual({
      blocked: true,
      category: "loopback",
    });
    expect(classifyIp("2002:0808:0808::1")).toEqual({ blocked: false });
    // Deprecated ::/96 compatibility range fails closed.
    expect(classifyIp("::102:0304")).toEqual({
      blocked: true,
      category: "reserved",
    });
  });

  it("fails closed on malformed input", () => {
    for (const ip of [
      "",
      "abc",
      "1.2.3",
      "1.2.3.4.5",
      "999.1.1.1",
      "1.2.3.256",
      "1::2::3",
      "fe80::1%eth0",
      "12345::",
    ]) {
      expect(classifyIp(ip), JSON.stringify(ip)).toEqual({
        blocked: true,
        category: "unparseable",
      });
    }
  });
});

describe("host preflight", () => {
  it("classifies literals without touching DNS", async () => {
    let calls = 0;
    const resolver = async (host: string): Promise<string[]> => {
      calls += 1;
      return [host];
    };
    expect(await preflightHost("93.184.216.34", { resolver })).toEqual({
      ok: true,
      addresses: ["93.184.216.34"],
    });
    expect(await preflightHost("127.0.0.1", { resolver })).toMatchObject({
      ok: false,
      outcome: "BLOCKED",
      reasonCode: "PRIVATE_NETWORK",
    });
    expect(calls).toBe(0);
  });

  it("accepts fully public answers and blocks mixed ones", async () => {
    const resolver = async (host: string): Promise<string[]> =>
      host === "mixed.example" ? ["93.184.216.34", "10.1.2.3"] : ["93.184.216.34"];
    expect(await preflightHost("example.com", { resolver })).toEqual({
      ok: true,
      addresses: ["93.184.216.34"],
    });
    expect(await preflightHost("mixed.example", { resolver })).toMatchObject({
      ok: false,
      outcome: "BLOCKED",
      reasonCode: "PRIVATE_NETWORK",
    });
  });

  it("maps resolver failures to invalid or retryable outcomes", async () => {
    const failing = (code: string) => async (): Promise<string[]> => {
      throw Object.assign(new Error(code), { code });
    };
    expect(
      await preflightHost("nx.example", { resolver: failing("ENOTFOUND") }),
    ).toMatchObject({
      ok: false,
      outcome: "INVALID",
      reasonCode: "INVALID_URL",
    });
    expect(
      await preflightHost("bad..name", { resolver: failing("EBADNAME") }),
    ).toMatchObject({ ok: false, outcome: "INVALID" });
    expect(
      await preflightHost("flaky.example", { resolver: failing("EAI_AGAIN") }),
    ).toMatchObject({
      ok: false,
      outcome: "BLOCKED",
      reasonCode: "TIMEOUT",
    });
    expect(
      await preflightHost("empty.example", { resolver: async () => [] }),
    ).toMatchObject({ ok: false, outcome: "INVALID" });
  });

  it("times out stalled lookups", async () => {
    const hanging = (): Promise<string[]> => new Promise(() => {});
    expect(
      await preflightHost("slow.example", {
        resolver: hanging,
        timeoutMs: 20,
      }),
    ).toMatchObject({
      ok: false,
      outcome: "BLOCKED",
      reasonCode: "TIMEOUT",
    });
  });
});
