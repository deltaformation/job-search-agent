import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ReasonCode } from "../domain/enums";

/**
 * SSRF preflight for intake: every canonical hostname resolves here before
 * anything is queued, and any non-public address fails the line. This is the
 * intake-time check only — the R2-C fetcher revalidates at connect time
 * (redirects, rebinding, subresources), since DNS answers can change.
 */

export const DNS_TIMEOUT_MS = 5000;

export type DnsResolver = (hostname: string) => Promise<string[]>;

export const defaultResolver: DnsResolver = async (hostname: string) => {
  const answers = await lookup(hostname, { all: true });
  return answers.map((answer) => answer.address);
};

export interface IpVerdict {
  blocked: boolean;
  /** Machine-readable category when blocked. */
  category?:
    | "loopback"
    | "private"
    | "link-local"
    | "multicast"
    | "reserved"
    | "unspecified"
    | "unparseable";
}

/** True when `value` falls in the inclusive range [first, last]. */
function inRange(value: number, first: number, last: number): boolean {
  return value >= first && value <= last;
}

function classifyIpv4(ip: string): IpVerdict {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return { blocked: true, category: "unparseable" };
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) {
      return { blocked: true, category: "unparseable" };
    }
    const octet = Number(part);
    if (octet > 255) {
      return { blocked: true, category: "unparseable" };
    }
    octets.push(octet);
  }
  const [a, b, c] = octets;

  if (a === 127) return { blocked: true, category: "loopback" };
  if (a === 10) return { blocked: true, category: "private" };
  if (a === 172 && inRange(b, 16, 31)) return { blocked: true, category: "private" };
  if (a === 192 && b === 168) return { blocked: true, category: "private" };
  if (a === 169 && b === 254) return { blocked: true, category: "link-local" };
  if (inRange(a, 224, 239)) return { blocked: true, category: "multicast" };
  if (a >= 240) return { blocked: true, category: "reserved" };
  if (a === 0) return { blocked: true, category: "reserved" };
  if (a === 100 && inRange(b, 64, 127)) return { blocked: true, category: "reserved" };
  if (a === 192 && b === 0 && (c === 0 || c === 2)) {
    return { blocked: true, category: "reserved" };
  }
  // 192.88.99.0/24 (6to4 relay, deprecated), 198.18.0.0/15 (benchmarking),
  // 198.51.100.0/24 + 203.0.113.0/24 (documentation).
  if (a === 192 && b === 88 && c === 99) return { blocked: true, category: "reserved" };
  if (a === 198 && (b === 18 || b === 19)) return { blocked: true, category: "reserved" };
  if (a === 198 && b === 51 && c === 100) return { blocked: true, category: "reserved" };
  if (a === 203 && b === 0 && c === 113) return { blocked: true, category: "reserved" };
  return { blocked: false };
}

/** Parse an IPv6 address to a 128-bit integer, or null when malformed. */
function parseIpv6(ip: string): bigint | null {
  if (ip.includes("%")) {
    return null;
  }
  let text = ip;
  if (text.startsWith("[") && text.endsWith("]")) {
    text = text.slice(1, -1);
  }
  // Dotted-quad tail (`::ffff:1.2.3.4`) becomes two hextets first.
  const dotTail = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotTail !== null) {
    const verdict = classifyIpv4(dotTail[1]);
    const octets = dotTail[1].split(".").map(Number);
    if (verdict.category === "unparseable" || octets.some((o) => o > 255)) {
      return null;
    }
    const high = ((octets[0] * 256 + octets[1]) as number).toString(16);
    const low = ((octets[2] * 256 + octets[3]) as number).toString(16);
    text = `${text.slice(0, text.length - dotTail[1].length)}${high}:${low}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail =
    halves.length === 2 ? (halves[1] === "" ? [] : halves[1].split(":")) : [];
  const hextet = /^[0-9a-fA-F]{1,4}$/;
  if (![...head, ...tail].every((part) => hextet.test(part))) {
    return null;
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) {
    return null;
  }
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) + BigInt(`0x${group}`);
  }
  return value;
}

function classifyIpv6(ip: string): IpVerdict {
  const value = parseIpv6(ip);
  if (value === null) {
    return { blocked: true, category: "unparseable" };
  }
  if (value === 0n) return { blocked: true, category: "unspecified" };
  if (value === 1n) return { blocked: true, category: "loopback" };
  // Deprecated ::/96 IPv4-compatible range (excluding mapped, handled below).
  if ((value >> 32n) === 0n) return { blocked: true, category: "reserved" };
  // IPv4-mapped ::ffff:0/96: classify the embedded IPv4 address.
  if ((value >> 32n) === 0xffffn) {
    const inner = Number(value & 0xffffffffn);
    const dotted = [24, 16, 8, 0].map((shift) => (inner >>> shift) & 0xff).join(".");
    return classifyIpv4(dotted);
  }
  // 6to4 2002::/16: classify the embedded IPv4 address (bits 16..47).
  if ((value >> 112n) === 0x2002n) {
    const inner = Number((value >> 80n) & 0xffffffffn);
    const dotted = [24, 16, 8, 0].map((shift) => (inner >>> shift) & 0xff).join(".");
    return classifyIpv4(dotted);
  }
  if ((value >> 118n) === 1018n) return { blocked: true, category: "link-local" };
  if ((value >> 121n) === 126n) return { blocked: true, category: "private" };
  if ((value >> 120n) === 0xffn) return { blocked: true, category: "multicast" };
  if ((value >> 96n) === 0x20010db8n) return { blocked: true, category: "reserved" };
  // 100::/64 discard prefix.
  if ((value >> 64n) === 0x0100000000000000n) {
    return { blocked: true, category: "reserved" };
  }
  return { blocked: false };
}

/**
 * Classify one IP literal. Unknown or malformed input fails closed.
 * Teredo (`2001::/32`) is intentionally not unpacked: the tunnel is
 * deprecated and clients here never route through it; the prefix itself
 * classifies as public and the fetcher still guards the connection.
 */
export function classifyIp(ip: string): IpVerdict {
  const trimmed = ip.trim();
  switch (isIP(trimmed)) {
    case 4:
      return classifyIpv4(trimmed);
    case 6:
      return classifyIpv6(trimmed);
    default:
      return { blocked: true, category: "unparseable" };
  }
}

export type PreflightResult =
  | { ok: true; addresses: string[] }
  | {
      ok: false;
      outcome: "INVALID" | "BLOCKED";
      reasonCode: ReasonCode;
      detail: string;
    };

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("dns timeout")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
    }
  });
}

export interface PreflightOptions {
  resolver?: DnsResolver;
  timeoutMs?: number;
}

/**
 * Resolve a canonical hostname and reject non-public answers. Literals skip
 * DNS. NXDOMAIN-style failures are invalid URLs; stalls and resolver errors
 * are retryable blocks; any single non-public answer blocks the host.
 */
export async function preflightHost(
  hostname: string,
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  if (isIP(hostname) !== 0) {
    const verdict = classifyIp(hostname);
    return verdict.blocked
      ? {
          ok: false,
          outcome: "BLOCKED",
          reasonCode: "PRIVATE_NETWORK",
          detail: `IP literal is ${verdict.category ?? "not public"}`,
        }
      : { ok: true, addresses: [hostname] };
  }
  const resolver = options.resolver ?? defaultResolver;
  let addresses: string[];
  try {
    addresses = await withTimeout(
      resolver(hostname),
      options.timeoutMs ?? DNS_TIMEOUT_MS,
    );
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOTFOUND" || code === "EBADNAME") {
      return {
        ok: false,
        outcome: "INVALID",
        reasonCode: "INVALID_URL",
        detail: "hostname does not resolve",
      };
    }
    return {
      ok: false,
      outcome: "BLOCKED",
      reasonCode: "TIMEOUT",
      detail: "hostname resolution failed or timed out",
    };
  }
  if (addresses.length === 0) {
    return {
      ok: false,
      outcome: "INVALID",
      reasonCode: "INVALID_URL",
      detail: "hostname has no addresses",
    };
  }
  const blocked = addresses.find((address) => classifyIp(address).blocked);
  if (blocked !== undefined) {
    return {
      ok: false,
      outcome: "BLOCKED",
      reasonCode: "PRIVATE_NETWORK",
      detail: `hostname resolves to a non-public address (${blocked})`,
    };
  }
  return { ok: true, addresses };
}
