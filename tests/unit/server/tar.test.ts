// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createTarWriter,
  extractTarStrict,
  gunzipTar,
  gzipTar,
  STRICT_EXTRACT_LIMITS,
  TAR_BLOCK,
  TarError,
} from "../../../src/server/tar";

function roundtrip(members: Array<[string, string]>): Array<{ name: string; data: Buffer }> {
  const writer = createTarWriter(1_700_000_000);
  for (const [name, text] of members) {
    writer.appendFile(name, Buffer.from(text, "utf8"));
  }
  return extractTarStrict(writer.finish(), STRICT_EXTRACT_LIMITS);
}

/** Recompute a member header checksum after byte-patching (test-only). */
function recheck(header: Buffer): void {
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : (header[index] as number);
  }
  header.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 32;
}

function singleMemberTar(name: string, text: string): Buffer {
  const writer = createTarWriter(1_700_000_000);
  writer.appendFile(name, Buffer.from(text, "utf8"));
  return writer.finish();
}

describe("tar writer", () => {
  it("round-trips empty, aligned, and unaligned members deterministically", () => {
    const members: Array<[string, string]> = [
      ["manifest.json", '{"v":1}'],
      ["empty.bin", ""],
      ["aligned.bin", "x".repeat(512)],
      ["odd.bin", "y".repeat(513)],
    ];
    const first = roundtrip(members);
    expect(first.map((m) => [m.name, m.data.toString("utf8")])).toEqual(members);
    const writer = createTarWriter(1_700_000_000);
    for (const [name, text] of members) {
      writer.appendFile(name, Buffer.from(text, "utf8"));
    }
    const again = createTarWriter(1_700_000_000);
    for (const [name, text] of members) {
      again.appendFile(name, Buffer.from(text, "utf8"));
    }
    expect(writer.finish().equals(again.finish())).toBe(true);
  });

  it("emits valid ustar headers", () => {
    const tar = singleMemberTar("a/b.txt", "hi");
    expect(tar.subarray(0, 7).toString("ascii")).toBe("a/b.txt");
    expect(tar.subarray(257, 262).toString("ascii")).toBe("ustar");
    expect(String.fromCharCode(tar[156] as number)).toBe("0");
    expect(tar.length % TAR_BLOCK).toBe(0);
  });

  it("rejects bad names, duplicates, and bad mtimes", () => {
    expect(() => createTarWriter(-1)).toThrow(TarError);
    const writer = createTarWriter(0);
    expect(() => writer.appendFile("", Buffer.alloc(0))).toThrow(TarError);
    expect(() => writer.appendFile("x".repeat(101), Buffer.alloc(0))).toThrow(TarError);
    writer.appendFile("dup", Buffer.alloc(0));
    expect(() => writer.appendFile("dup", Buffer.alloc(0))).toThrow(TarError);
  });

  it("gzip round-trips deterministically", () => {
    const tar = singleMemberTar("m", "data");
    const first = gzipTar(tar, 1_700_000_000);
    const second = gzipTar(tar, 1_700_000_000);
    expect(first.equals(second)).toBe(true);
    expect(gunzipTar(first, 1_000_000).equals(tar)).toBe(true);
  });
});

describe("tar strict extraction", () => {
  it.each(["../evil", "/abs", "a/../../b", "a\\b", "a//b", ".", "a/./b"])(
    "rejects escaping names: %s",
    (name) => {
      expect(() => extractTarStrict(singleMemberTar(name, "x"), STRICT_EXTRACT_LIMITS)).toThrow(
        TarError,
      );
    },
  );

  it("rejects non-regular typeflags with a valid checksum", () => {
    for (const flag of ["1", "2", "3", "4", "6", "L", "K", "x", "g"]) {
      const tar = Buffer.from(singleMemberTar("link", "target"));
      tar[156] = flag.charCodeAt(0);
      recheck(tar.subarray(0, TAR_BLOCK));
      expect(() => extractTarStrict(tar, STRICT_EXTRACT_LIMITS)).toThrow(TarError);
    }
  });

  it("skips directory entries but rejects duplicates", () => {
    const tar = Buffer.from(singleMemberTar("dir", ""));
    tar[156] = "5".charCodeAt(0);
    recheck(tar.subarray(0, TAR_BLOCK));
    expect(extractTarStrict(tar, STRICT_EXTRACT_LIMITS)).toEqual([]);
    const writer = createTarWriter(0);
    writer.appendFile("a", Buffer.from("1"));
    writer.appendFile("b", Buffer.from("2"));
    const doubled = Buffer.concat([
      writer.finish().subarray(0, TAR_BLOCK * 2),
      writer.finish().subarray(0, TAR_BLOCK * 2),
      Buffer.alloc(TAR_BLOCK),
    ]);
    expect(() => extractTarStrict(doubled, STRICT_EXTRACT_LIMITS)).toThrow(/duplicate/);
  });

  it("rejects bad magic, bad checksums, and truncation", () => {
    const good = singleMemberTar("ok", "data");
    const badMagic = Buffer.from(good);
    badMagic.write("notar", 257, 5, "ascii");
    expect(() => extractTarStrict(badMagic, STRICT_EXTRACT_LIMITS)).toThrow(TarError);
    const badSum = Buffer.from(good);
    badSum[100] = ((badSum[100] as number) + 1) % 256;
    expect(() => extractTarStrict(badSum, STRICT_EXTRACT_LIMITS)).toThrow(/checksum/);
    expect(() => extractTarStrict(good.subarray(0, 100), STRICT_EXTRACT_LIMITS)).toThrow(
      /truncated/,
    );
    expect(() => extractTarStrict(good.subarray(0, TAR_BLOCK), STRICT_EXTRACT_LIMITS)).toThrow(
      /truncated/,
    );
  });

  it("enforces file count, file size, and total limits", () => {
    const big = singleMemberTar("big", "x".repeat(100));
    expect(() =>
      extractTarStrict(big, { maxFiles: 10, maxFileBytes: 10, maxTotalBytes: 1000 }),
    ).toThrow(/per-file/);
    expect(() =>
      extractTarStrict(big, { maxFiles: 10, maxFileBytes: 1000, maxTotalBytes: 10 }),
    ).toThrow(/total/);
    const writer = createTarWriter(0);
    writer.appendFile("a", Buffer.from("1"));
    writer.appendFile("b", Buffer.from("2"));
    expect(() =>
      extractTarStrict(writer.finish(), { maxFiles: 1, maxFileBytes: 100, maxTotalBytes: 100 }),
    ).toThrow(/file count/);
  });

  it("rejects corrupt gzip and gzip bombs", () => {
    expect(() => gunzipTar(Buffer.from("not-gzip-at-all!!!!"), 1000)).toThrow(TarError);
    const tar = singleMemberTar("m", "x".repeat(10000));
    expect(() => gunzipTar(gzipTar(tar, 0), 100)).toThrow(TarError);
  });
});
