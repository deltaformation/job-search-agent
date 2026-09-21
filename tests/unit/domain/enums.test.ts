// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Arrangement,
  AttemptResult,
  BoardStatus,
  IntakeOutcome,
  ReasonCode,
  RecordedBy,
  ResumeArtifactKind,
  ReviewAction,
  ReviewState,
  ScrapeState,
  SourceArtifactKind,
  TailoringState,
  Verification,
  WorkAttemptState,
  WorkKind,
  WorkState,
} from "../../../src/domain";

const ENUM_CASES: ReadonlyArray<{
  name: string;
  schema: z.ZodEnum<Record<string, string>>;
  valid: readonly string[];
}> = [
  { name: "BoardStatus", schema: BoardStatus, valid: ["NEW", "TAILORED", "APPLIED", "INTERVIEWED", "REJECTED"] },
  { name: "ScrapeState", schema: ScrapeState, valid: ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "BLOCKED"] },
  {
    name: "TailoringState",
    schema: TailoringState,
    valid: ["PENDING", "READY", "BLOCKED", "RUNNING", "AWAITING_REVIEW", "APPROVED", "REVISION_REQUESTED", "DECLINED", "FAILED"],
  },
  {
    name: "ReviewState",
    schema: ReviewState,
    valid: ["DRAFT", "AWAITING_REVIEW", "APPROVED", "REVISION_REQUESTED", "DECLINED", "FAILED"],
  },
  { name: "WorkKind", schema: WorkKind, valid: ["SCRAPE", "TAILOR", "PREPARE"] },
  { name: "WorkState", schema: WorkState, valid: ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] },
  { name: "AttemptResult", schema: AttemptResult, valid: ["SUCCEEDED", "FAILED", "BLOCKED"] },
  { name: "WorkAttemptState", schema: WorkAttemptState, valid: ["RUNNING", "SUCCEEDED", "FAILED", "BLOCKED"] },
  { name: "IntakeOutcome", schema: IntakeOutcome, valid: ["PENDING", "ENQUEUED", "INVALID", "DUPLICATE", "BLOCKED"] },
  { name: "SourceArtifactKind", schema: SourceArtifactKind, valid: ["HTML", "TEXT", "JSONLD"] },
  { name: "ResumeArtifactKind", schema: ResumeArtifactKind, valid: ["MARKDOWN", "DOCX", "PDF"] },
  { name: "Arrangement", schema: Arrangement, valid: ["REMOTE", "HYBRID", "ONSITE", "UNKNOWN"] },
  { name: "Verification", schema: Verification, valid: ["PENDING", "APPROVED", "REJECTED"] },
  { name: "ReviewAction", schema: ReviewAction, valid: ["APPROVED", "REVISION_REQUESTED", "DECLINED"] },
  {
    name: "ReasonCode",
    schema: ReasonCode,
    valid: [
      "INVALID_URL",
      "DUPLICATE_URL",
      "PRIVATE_NETWORK",
      "LOGIN_REQUIRED",
      "CAPTCHA_REQUIRED",
      "ACCESS_DENIED",
      "TIMEOUT",
      "EXTRACTION_INCOMPLETE",
      "UNSUPPORTED_PAGE",
      "PROFILE_REQUIRED",
      "PROVIDER_UNAVAILABLE",
      "STALE_INPUT",
      "RENDER_FAILED",
      "VERSION_DECLINED",
      // WO-1.3-F: v1.3 worker failure codes plus the recovery-side
      // exhaustion marker.
      "CONFIGURATION",
      "AUTHENTICATION",
      "RATE_LIMIT",
      "NETWORK",
      "PROVIDER_TIMEOUT",
      "LOCAL_LAUNCH",
      "INVALID_RESPONSE",
      "INPUT_STALE",
      "PROFILE_UNAVAILABLE",
      "CLAIM_VALIDATION",
      "PUBLISH_FAILED",
      "INTERNAL",
      "LEASE_LOST",
    ],
  },
];

describe("domain enums", () => {
  for (const { name, schema, valid } of ENUM_CASES) {
    it(`${name} accepts exactly its documented values`, () => {
      expect([...schema.options].sort()).toEqual([...valid].sort());
      for (const value of valid) {
        expect(schema.safeParse(value).success, value).toBe(true);
      }
      expect(schema.safeParse("NOPE").success).toBe(false);
      expect(schema.safeParse("").success).toBe(false);
      expect(schema.safeParse(null).success).toBe(false);
    });
  }

  it("RecordedBy admits only human", () => {
    expect(RecordedBy.safeParse("human").success).toBe(true);
    expect(RecordedBy.safeParse("agent").success).toBe(false);
  });
});
