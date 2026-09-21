import { createHash } from "node:crypto";
import {
  FocusV1,
  RecommendationV1,
  type FocusV1 as FocusV1Type,
  type RecommendationV1 as RecommendationV1Type,
} from "../../../src/domain/tailoringWorkspace";

/**
 * Minimal hand-built v1.3 focus pair for E3 provider/compiler specs.
 * Phrase IDs are opaque SHA-256 labels (no mockup bytes); roles mirror
 * the shared orchestration fixture (`emp-1` owns the scale/team facts,
 * `emp-2` owns the API/auth facts).
 */

function sha(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

export const V2_EXTRACTION_ID = "11111111-1111-4111-8111-111111111111";
export const V2_PROFILE_VERSION_ID = "22222222-2222-4222-8222-222222222222";
export const V2_REDIS_PHRASE_ID = sha("v2-phrase:redis-caching");
export const V2_TYPESCRIPT_PHRASE_ID = sha("v2-phrase:typescript-api");

function baseRecommendations(): RecommendationV1Type {
  return RecommendationV1.parse({
    schemaVersion: "tailoring-recommendations/v1",
    policyVersion: "recommendations/1",
    extractionId: V2_EXTRACTION_ID,
    jdHash: sha("v2-jd"),
    profileVersionId: V2_PROFILE_VERSION_ID,
    profileHash: sha("v2-profile"),
    phrases: [
      {
        id: V2_REDIS_PHRASE_ID,
        text: "Redis caching",
        startByte: 0,
        endByte: 13,
        excerpt: "Redis caching is a plus.",
        count: 1,
        category: "Technical",
        support: "supported",
        factIds: ["f_scale"],
      },
      {
        id: V2_TYPESCRIPT_PHRASE_ID,
        text: "TypeScript API experience",
        startByte: 14,
        endByte: 39,
        excerpt: "We need TypeScript API experience.",
        count: 1,
        category: "Technical",
        support: "supported",
        factIds: ["f_api"],
      },
    ],
    roles: [
      { id: "emp-1", label: "Engineer @ Acme", factIds: ["f_scale", "f_team"] },
      { id: "emp-2", label: "Senior Engineer @ Beta", factIds: ["f_api", "f_auth"] },
    ],
    themes: [
      {
        id: "experience",
        title: "experience",
        factIds: ["f_api", "f_auth", "f_scale", "f_team"],
        summaryDirection: "Backend delivery.",
      },
    ],
    preset: {
      schemaVersion: "tailoring-focus/v1",
      selectedPhraseIds: [V2_REDIS_PHRASE_ID],
      themeId: "experience",
      summaryDirection: "",
      mappings: [],
      additionalGuidance: "",
    },
  });
}

function baseFocus(): FocusV1Type {
  return FocusV1.parse({
    schemaVersion: "tailoring-focus/v1",
    selectedPhraseIds: [V2_REDIS_PHRASE_ID],
    themeId: "experience",
    summaryDirection: "",
    mappings: [
      { roleId: "emp-1", phraseId: V2_REDIS_PHRASE_ID, factIds: ["f_scale"] },
    ],
    additionalGuidance: "",
  });
}

export function v2FocusPair(overrides: {
  focus?: Partial<FocusV1Type>;
  recommendations?: Partial<RecommendationV1Type>;
} = {}): { focus: FocusV1Type; recommendations: RecommendationV1Type } {
  const recommendations = RecommendationV1.parse({
    ...baseRecommendations(),
    ...overrides.recommendations,
  });
  const focus = FocusV1.parse({ ...baseFocus(), ...overrides.focus });
  return { focus, recommendations };
}
