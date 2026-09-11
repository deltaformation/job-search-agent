// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApprovalRecord, ReviewCommand } from "../../../src/domain";

const VERSION_ID = "123e4567-e89b-12d3-a456-426614174000";
const HEX_64 = "a".repeat(64);

describe("review commands and approval records", () => {
  it("accepts human approval with an optional note", () => {
    expect(
      ReviewCommand.safeParse({
        action: "APPROVED",
        resumeVersionId: VERSION_ID,
        actor: "human",
      }).success,
    ).toBe(true);
    expect(
      ReviewCommand.safeParse({
        action: "APPROVED",
        resumeVersionId: VERSION_ID,
        actor: "human",
        note: "Looks right.",
      }).success,
    ).toBe(true);
  });

  it("rejects non-human reviewers and malformed approvals", () => {
    expect(
      ReviewCommand.safeParse({
        action: "APPROVED",
        resumeVersionId: VERSION_ID,
        actor: "agent",
      }).success,
    ).toBe(false);
    expect(
      ReviewCommand.safeParse({
        action: "APPROVED",
        resumeVersionId: "not-a-uuid",
        actor: "human",
      }).success,
    ).toBe(false);
    expect(
      ReviewCommand.safeParse({
        action: "EDITED",
        resumeVersionId: VERSION_ID,
        actor: "human",
      }).success,
    ).toBe(false);
  });

  it("requires a note when requesting revision", () => {
    expect(
      ReviewCommand.safeParse({
        action: "REVISION_REQUESTED",
        resumeVersionId: VERSION_ID,
        actor: "human",
        note: "Second bullet overstates the metric.",
      }).success,
    ).toBe(true);
    expect(
      ReviewCommand.safeParse({
        action: "REVISION_REQUESTED",
        resumeVersionId: VERSION_ID,
        actor: "human",
      }).success,
    ).toBe(false);
    expect(
      ReviewCommand.safeParse({
        action: "REVISION_REQUESTED",
        resumeVersionId: VERSION_ID,
        actor: "human",
        note: "  ",
      }).success,
    ).toBe(false);
  });

  it("binds approvals to exact artifact digests", () => {
    const record = {
      resumeVersionId: VERSION_ID,
      action: "APPROVED",
      actor: "human",
      resumeHash: HEX_64,
      contentHash: HEX_64,
      artifactHashes: { markdown: HEX_64, docx: HEX_64, pdf: HEX_64 },
    };
    expect(ApprovalRecord.safeParse(record).success).toBe(true);
    expect(
      ApprovalRecord.safeParse({ ...record, contentHash: "zz" }).success,
    ).toBe(false);
    expect(
      ApprovalRecord.safeParse({
        ...record,
        artifactHashes: { markdown: HEX_64, docx: HEX_64 },
      }).success,
    ).toBe(false);
    expect(
      ApprovalRecord.safeParse({ ...record, approvalState: "yes" }).success,
    ).toBe(false);
    expect(ApprovalRecord.safeParse({ ...record, actor: "agent" }).success).toBe(
      false,
    );
  });

  it("exposes the command as a discriminated union for exhaustive handling", () => {
    expect(ReviewCommand).toBeInstanceOf(z.ZodDiscriminatedUnion);
  });
});
