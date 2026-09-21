// @vitest-environment node
import { describe, expect, it } from "vitest";
import { sha256HexUtf8 } from "../../../src/tailoring/hash";
import { canonicalText } from "../../../src/domain/canonical";
import type { StoredProfilePayload } from "../../../src/domain/candidate";
import {
  RecommendationV1,
  validateFocusSelection,
} from "../../../src/domain/tailoringWorkspace";
import {
  extractUtf8ByteRange,
  hashRecommendation,
  phraseIdFor,
} from "../../../src/tailoring/requestsV3";
import type { SupportEvidence } from "../../../src/tailoring/support";
import {
  buildRecommendations,
  type RecommendationBuildInput,
} from "../../../src/tailoring/recommendations";

/**
 * D3/D4 builder leg: the deterministic recommendation builder is a
 * pure function of canonical JD + immutable payload + approved
 * facts. Byte ranges cite exact UTF-8 slices, IDs/counts/support
 * derive from the reused extractor/support services, and the preset
 * is always a valid FocusV1 over its own snapshot.
 */

const EXTRACTION_ID = "11111111-1111-4111-8111-111111111111";
const PROFILE_VERSION_ID = "22222222-2222-4222-8222-222222222222";

function payload(overrides: Partial<StoredProfilePayload> = {}): StoredProfilePayload {
  return {
    schemaVersion: "candidate-profile/v1",
    identity: { fullName: "Test Candidate" },
    targetTitles: [],
    targetLocations: [],
    summary: "Product leader shipping B2B SaaS with TypeScript APIs.",
    employment: [
      {
        id: "emp-one",
        company: "Harbor Analytics",
        role: "Product Manager",
        startDate: "2021-01-15",
        isCurrent: true,
      },
      {
        id: "emp-two",
        company: "Beacon Tools",
        role: "Associate Product Manager",
        startDate: "2019-06-01",
        endDate: "2020-12-31",
        isCurrent: false,
      },
    ],
    achievements: [
      {
        factId: "fact-api",
        employmentId: "emp-one",
        category: "delivery",
        text: "Shipped TypeScript APIs serving PostgreSQL-backed dashboards.",
        technologies: [],
        metrics: [],
        verification: "APPROVED",
      },
      {
        factId: "fact-cache",
        employmentId: "emp-one",
        category: "delivery",
        text: "Cut p99 latency with Redis caching layers.",
        technologies: [],
        metrics: [],
        verification: "APPROVED",
      },
      {
        factId: "fact-gtm",
        employmentId: "emp-two",
        category: "strategy",
        text: "Ran go-to-market launches with product marketing.",
        technologies: [],
        metrics: [],
        verification: "APPROVED",
      },
    ],
    skills: [],
    education: [],
    credentials: [],
    ...overrides,
  } as StoredProfilePayload;
}

function evidenceOf(entries: Array<{ factId: string; statement: string }>): SupportEvidence[] {
  return entries.map((entry) => ({ ...entry, evidenceJson: null }));
}

function build(
  jdText: string,
  facts: SupportEvidence[],
  payloadOverrides: Partial<StoredProfilePayload> = {},
): ReturnType<typeof buildRecommendations> {
  const canonical = canonicalText(jdText);
  const input: RecommendationBuildInput = {
    extractionId: EXTRACTION_ID,
    canonicalJdText: canonical,
    jdHash: sha256HexUtf8(canonical),
    profileVersionId: PROFILE_VERSION_ID,
    profileHash: "a".repeat(64),
    payload: payload(payloadOverrides),
    approvedFacts: facts,
  };
  return buildRecommendations(input);
}

const APPROVED = evidenceOf([
  { factId: "fact-api", statement: "Shipped TypeScript APIs serving PostgreSQL-backed dashboards." },
  { factId: "fact-cache", statement: "Cut p99 latency with Redis caching layers." },
  { factId: "fact-gtm", statement: "Ran go-to-market launches with product marketing." },
]);

describe("buildRecommendations", () => {
  it("emits canonical byte-range phrases with exact IDs, counts, and excerpts", () => {
    const jd = "We need TypeScript APIs and more TypeScript APIs. Redis caching required.";
    const canonical = canonicalText(jd);
    const rec = build(jd, APPROVED);
    expect(RecommendationV1.parse(rec)).toEqual(rec);
    expect(rec.extractionId).toBe(EXTRACTION_ID);
    expect(rec.profileVersionId).toBe(PROFILE_VERSION_ID);
    const typescript = rec.phrases.filter((phrase) => phrase.text === "TypeScript");
    expect(typescript).toHaveLength(1);
    const phrase = typescript[0] as (typeof rec.phrases)[number];
    // Exact decoded slice: the bytes select the cited text and nothing else.
    expect(extractUtf8ByteRange(canonical, phrase.startByte, phrase.endByte)).toBe("TypeScript");
    expect(phrase.id).toBe(
      phraseIdFor({
        extractionId: EXTRACTION_ID,
        jdHash: sha256HexUtf8(canonical),
        startByte: phrase.startByte,
        endByte: phrase.endByte,
        text: "TypeScript",
      }),
    );
    expect(phrase.count).toBe(2);
    expect(phrase.excerpt.length).toBeGreaterThan(0);
    expect(phrase.excerpt.length).toBeLessThanOrEqual(1024);
    expect(phrase.category).toBe("Technical");
  });

  it("addresses UTF-8 bytes, never UTF-16 indices, after a non-ASCII prefix", () => {
    const jd = "Café naïve façade — Zürich München — TypeScript APIs with Redis.";
    const canonical = canonicalText(jd);
    const rec = build(jd, APPROVED);
    const typescript = rec.phrases.find((phrase) => phrase.text === "TypeScript");
    expect(typescript).toBeDefined();
    const phrase = typescript as (typeof rec.phrases)[number];
    // The UTF-16 index of "TypeScript" differs from its UTF-8 byte
    // offset once multibyte characters precede it; the range must be
    // bytes or the slice decodes garbage.
    const utf16Index = canonical.indexOf("TypeScript");
    expect(phrase.startByte).toBeGreaterThan(utf16Index);
    expect(extractUtf8ByteRange(canonical, phrase.startByte, phrase.endByte)).toBe("TypeScript");
    expect(phrase.id).toBe(
      phraseIdFor({
        extractionId: EXTRACTION_ID,
        jdHash: sha256HexUtf8(canonical),
        startByte: phrase.startByte,
        endByte: phrase.endByte,
        text: "TypeScript",
      }),
    );
  });

  it("never matches standalone Go inside go-to-market", () => {
    const jd = "Own go-to-market launches and go-to-market playbooks for B2B SaaS.";
    const rec = build(jd, APPROVED);
    const texts = rec.phrases.map((phrase) => phrase.text);
    expect(texts).toContain("go-to-market");
    expect(texts).not.toContain("Go");
    const gtm = rec.phrases.find((phrase) => phrase.text === "go-to-market");
    expect(gtm?.count).toBe(2);
    expect(gtm?.category).toBe("Business");
  });

  it("excludes boilerplate and never pads sparse JDs", () => {
    const boilerplate = build(
      "We leverage synergy to leverage synergy and leverage synergy daily.",
      APPROVED,
    );
    expect(boilerplate.phrases.map((phrase) => phrase.text.toLowerCase())).not.toContain("leverage");
    expect(boilerplate.phrases.map((phrase) => phrase.text.toLowerCase())).not.toContain("synergy");
    const sparse = build("We need help.", APPROVED);
    expect(sparse.phrases).toEqual([]);
    // An empty cloud still yields a valid snapshot with an empty preset.
    expect(sparse.preset.selectedPhraseIds).toEqual([]);
    expect(sparse.preset.mappings).toEqual([]);
    expect(validateFocusSelection(sparse.preset, sparse)).toEqual([]);
  });

  it("grades support from approved facts only", () => {
    const jd = "TypeScript APIs with Redis caching. NetSuite ERP integrations required.";
    const rec = build(jd, APPROVED);
    const byText = new Map(rec.phrases.map((phrase) => [phrase.text, phrase]));
    // "NetSuite" is not curated and appears once: no phrase at all.
    // TypeScript/Redis are evidenced by approved facts.
    expect(byText.get("TypeScript")?.support).toBe("supported");
    expect(byText.get("TypeScript")?.factIds).toContain("fact-api");
    expect(byText.get("Redis")?.support).toBe("supported");
    expect(byText.get("Redis")?.factIds).toContain("fact-cache");
    // Unapproved facts never contribute support.
    const pending = build(jd, []);
    for (const phrase of pending.phrases) {
      expect(phrase.factIds).toEqual([]);
      expect(phrase.support === "supported" ? phrase.factIds.length : 0).toBe(0);
    }
    expect(pending.preset.selectedPhraseIds).toEqual([]);
    expect(pending.preset.mappings).toEqual([]);
  });

  it("keys roles by immutable payload employment IDs with owned approved facts", () => {
    const rec = build("TypeScript APIs.", APPROVED);
    expect(rec.roles.map((role) => role.id)).toEqual(["emp-one", "emp-two"]);
    const one = rec.roles[0] as (typeof rec.roles)[number];
    expect(one.label).toContain("Product Manager");
    expect(one.label).toContain("Harbor Analytics");
    expect(one.factIds).toEqual(["fact-api", "fact-cache"]);
    const two = rec.roles[1] as (typeof rec.roles)[number];
    expect(two.factIds).toEqual(["fact-gtm"]);
  });

  it("groups themes by achievement category with the canonical master summary", () => {
    const rec = build("TypeScript APIs.", APPROVED);
    expect(rec.themes.map((theme) => theme.id)).toEqual(["delivery", "strategy"]);
    const delivery = rec.themes[0] as (typeof rec.themes)[number];
    expect(delivery.title).toBe("delivery");
    expect(delivery.factIds).toEqual(["fact-api", "fact-cache"]);
    expect(delivery.summaryDirection).toBe(
      "Product leader shipping B2B SaaS with TypeScript APIs.",
    );
    // Preset theme is the theme with the most approved facts.
    expect(rec.preset.themeId).toBe("delivery");
    expect(rec.preset.summaryDirection).toBe(delivery.summaryDirection);
  });

  it("falls back to approved statements when the payload carries no summary", () => {
    const { summary: _dropped, ...rest } = payload();
    void _dropped;
    const canonical = canonicalText("TypeScript APIs.");
    const rec = buildRecommendations({
      extractionId: EXTRACTION_ID,
      canonicalJdText: canonical,
      jdHash: sha256HexUtf8(canonical),
      profileVersionId: PROFILE_VERSION_ID,
      profileHash: "a".repeat(64),
      payload: rest,
      approvedFacts: APPROVED,
    });
    expect(rec.preset.summaryDirection).toContain("Shipped TypeScript APIs");
    expect(rec.preset.summaryDirection).toContain("Redis caching");
    expect(rec.preset.summaryDirection.length).toBeLessThanOrEqual(4000);
  });

  it("selects only short supported phrases and maps them to owning roles", () => {
    const jd = "TypeScript APIs with Redis caching and go-to-market launches.";
    const rec = build(jd, APPROVED);
    const selected = new Set(rec.preset.selectedPhraseIds);
    expect(selected.size).toBeGreaterThan(0);
    for (const phrase of rec.phrases) {
      if (selected.has(phrase.id)) {
        expect(phrase.support).toBe("supported");
        expect(phrase.factIds.length).toBeGreaterThan(0);
        expect(phrase.text.length).toBeLessThanOrEqual(128);
      }
    }
    for (const mapping of rec.preset.mappings) {
      expect(selected.has(mapping.phraseId)).toBe(true);
      const role = rec.roles.find((entry) => entry.id === mapping.roleId);
      expect(role).toBeDefined();
      for (const factId of mapping.factIds) {
        expect(role?.factIds).toContain(factId);
      }
      const phrase = rec.phrases.find((entry) => entry.id === mapping.phraseId);
      for (const factId of mapping.factIds) {
        expect(phrase?.factIds).toContain(factId);
      }
    }
    expect(rec.preset.additionalGuidance).toBe("");
    expect(validateFocusSelection(rec.preset, rec)).toEqual([]);
  });

  it("skips phrases over 512 characters instead of emitting invalid schema", () => {
    const blob = `x${"y".repeat(600)}x`;
    const jd = `TypeScript APIs. ${blob} ${blob} needs attention.`;
    const rec = build(jd, APPROVED);
    for (const phrase of rec.phrases) {
      expect(phrase.text.length).toBeLessThanOrEqual(512);
    }
    expect(rec.phrases.map((phrase) => phrase.text)).toContain("TypeScript");
  });

  it("is byte-deterministic over the same binding", () => {
    const jd = "TypeScript APIs with Redis caching and go-to-market launches.";
    const first = build(jd, APPROVED);
    const second = build(jd, APPROVED);
    expect(hashRecommendation(second)).toBe(hashRecommendation(first));
    expect(RecommendationV1.parse(second)).toEqual(first);
  });
});
