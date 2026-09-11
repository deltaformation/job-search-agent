// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CanonicalError,
  canonicalJson,
  canonicalText,
} from "../../../src/domain/canonical";

describe("canonicalJson", () => {
  it("sorts object keys and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: [3, 2, 1] })).toBe('{"a":[3,2,1],"b":1}');
  });

  it("sorts nested keys recursively", () => {
    expect(canonicalJson({ z: { b: 1, a: 2 } })).toBe('{"z":{"a":2,"b":1}}');
  });

  it("is byte-stable across runs and key insertion order", () => {
    const left = canonicalJson({ b: [1, { d: 4, c: 3 }], a: "x" });
    const right = canonicalJson({ a: "x", b: [1, { c: 3, d: 4 }] });
    expect(left).toBe(right);
  });

  it("normalizes strings to NFC and LF", () => {
    const decomposed = "é"; // e + combining acute (U+0301)
    expect(canonicalJson({ t: `${decomposed}\r\nline` })).toBe(
      JSON.stringify({ t: "é\nline" }),
    );
  });

  it("rejects non-finite numbers", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => canonicalJson({ n: value })).toThrow(CanonicalError);
    }
  });

  it("rejects undefined, bigint, functions, and symbols", () => {
    expect(() => canonicalJson({ u: undefined })).toThrow(CanonicalError);
    expect(() => canonicalJson({ b: 1n })).toThrow(CanonicalError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(CanonicalError);
    expect(() => canonicalJson({ s: Symbol("x") })).toThrow(CanonicalError);
  });

  it("rejects Date instances instead of guessing a format", () => {
    expect(() => canonicalJson({ at: new Date() })).toThrow(CanonicalError);
  });

  it("rejects cyclical structures", () => {
    const cyclical: Record<string, unknown> = {};
    cyclical.self = cyclical;
    expect(() => canonicalJson(cyclical)).toThrow(CanonicalError);
  });

  it("rejects Maps, Sets, and class instances", () => {
    expect(() => canonicalJson(new Map([["a", 1]]))).toThrow(CanonicalError);
    expect(() => canonicalJson(new Set([1]))).toThrow(CanonicalError);
    expect(() => canonicalJson(new (class Box {})())).toThrow(CanonicalError);
  });
});

describe("canonicalText", () => {
  it("strips NUL bytes, folds newlines, normalizes, and trims", () => {
    expect(canonicalText("  Senior\r\nEngineer\0 (é)  ")).toBe("Senior\nEngineer (é)");
  });

  it("reduces blank text to the empty string", () => {
    expect(canonicalText(" \r\n \0 ")).toBe("");
  });
});
