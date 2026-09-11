// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isTerminalScrapeState,
  planReviewTransition,
  planScrapeTransition,
  planTailoringTransition,
} from "../../../src/domain";

describe("scrape state machine", () => {
  it("runs QUEUED to RUNNING to a reason-coded outcome", () => {
    expect(planScrapeTransition("QUEUED", { to: "RUNNING" })).toEqual({
      ok: true,
      from: "QUEUED",
      to: "RUNNING",
    });
    expect(planScrapeTransition("RUNNING", { to: "SUCCEEDED" }).ok).toBe(true);
    expect(
      planScrapeTransition("RUNNING", { to: "FAILED", reasonCode: "TIMEOUT" }).ok,
    ).toBe(true);
    expect(
      planScrapeTransition("RUNNING", {
        to: "BLOCKED",
        reasonCode: "LOGIN_REQUIRED",
      }).ok,
    ).toBe(true);
  });

  it("requires reason codes on failure outcomes", () => {
    expect(planScrapeTransition("RUNNING", { to: "FAILED" })).toMatchObject({
      ok: false,
      error: "reason-required",
    });
    expect(planScrapeTransition("RUNNING", { to: "BLOCKED" })).toMatchObject({
      ok: false,
      error: "reason-required",
    });
  });

  it("requeues failures but never re-scrapes success", () => {
    expect(planScrapeTransition("FAILED", { to: "QUEUED" }).ok).toBe(true);
    expect(planScrapeTransition("BLOCKED", { to: "QUEUED" }).ok).toBe(true);
    expect(planScrapeTransition("SUCCEEDED", { to: "QUEUED" })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(planScrapeTransition("QUEUED", { to: "SUCCEEDED" })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(isTerminalScrapeState("SUCCEEDED")).toBe(true);
    expect(isTerminalScrapeState("FAILED")).toBe(false);
  });
});

describe("tailoring state machine", () => {
  it("runs PENDING to RUNNING to review or failure", () => {
    expect(planTailoringTransition("PENDING", { to: "RUNNING" }).ok).toBe(true);
    expect(
      planTailoringTransition("PENDING", {
        to: "BLOCKED",
        reasonCode: "PROFILE_REQUIRED",
      }).ok,
    ).toBe(true);
    expect(
      planTailoringTransition("RUNNING", { to: "AWAITING_REVIEW" }).ok,
    ).toBe(true);
    expect(
      planTailoringTransition("AWAITING_REVIEW", { to: "APPROVED" }).ok,
    ).toBe(true);
    expect(
      planTailoringTransition("AWAITING_REVIEW", { to: "REVISION_REQUESTED" })
        .ok,
    ).toBe(true);
  });

  it("requires reason codes on blocked and failed outcomes", () => {
    expect(planTailoringTransition("PENDING", { to: "BLOCKED" })).toMatchObject(
      { ok: false, error: "reason-required" },
    );
    expect(
      planTailoringTransition("RUNNING", { to: "FAILED" }),
    ).toMatchObject({ ok: false, error: "reason-required" });
    expect(
      planTailoringTransition("AWAITING_REVIEW", {
        to: "FAILED",
        reasonCode: "PROVIDER_UNAVAILABLE",
      }).ok,
    ).toBe(true);
  });

  it("retries blocked, failed, and revision-requested runs", () => {
    expect(planTailoringTransition("BLOCKED", { to: "RUNNING" }).ok).toBe(true);
    expect(planTailoringTransition("FAILED", { to: "RUNNING" }).ok).toBe(true);
    expect(planTailoringTransition("REVISION_REQUESTED", { to: "RUNNING" }).ok).toBe(
      true,
    );
    expect(planTailoringTransition("APPROVED", { to: "RUNNING" })).toMatchObject(
      { ok: false, error: "forbidden" },
    );
    expect(
      planTailoringTransition("PENDING", { to: "APPROVED" }),
    ).toMatchObject({ ok: false, error: "forbidden" });
  });
});

describe("review state machine", () => {
  it("advances DRAFT to review to a terminal decision", () => {
    expect(planReviewTransition("DRAFT", { to: "AWAITING_REVIEW" }).ok).toBe(
      true,
    );
    expect(planReviewTransition("AWAITING_REVIEW", { to: "APPROVED" }).ok).toBe(
      true,
    );
    expect(
      planReviewTransition("AWAITING_REVIEW", { to: "REVISION_REQUESTED" }).ok,
    ).toBe(true);
    expect(
      planReviewTransition("DRAFT", {
        to: "FAILED",
        reasonCode: "PROVIDER_UNAVAILABLE",
      }).ok,
    ).toBe(true);
  });

  it("freezes terminal review states and requires failure reasons", () => {
    expect(planReviewTransition("DRAFT", { to: "FAILED" })).toMatchObject({
      ok: false,
      error: "reason-required",
    });
    expect(planReviewTransition("APPROVED", { to: "DRAFT" })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(
      planReviewTransition("REVISION_REQUESTED", { to: "AWAITING_REVIEW" }),
    ).toMatchObject({ ok: false, error: "forbidden" });
    expect(planReviewTransition("DRAFT", { to: "APPROVED" })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
  });
});
