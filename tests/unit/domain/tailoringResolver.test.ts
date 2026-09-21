import { describe, expect, it } from "vitest";
import {
  resolveAuthoritativeStep,
  type ResolverVersionSummary,
} from "../../../src/domain/tailoringResolver";

describe("Authoritative Step Resolver (§5, C5, C6)", () => {
  const sampleVersions: ResolverVersionSummary[] = [
    {
      id: "ver-1",
      version: 1,
      reviewState: "APPROVED",
      selectedApproved: true,
      latestPublished: false,
    },
    {
      id: "ver-2",
      version: 2,
      reviewState: "AWAITING_REVIEW",
      selectedApproved: false,
      latestPublished: true,
    },
  ];

  it("resolves absent workspace / fresh job to Step 1", () => {
    const result = resolveAuthoritativeStep({
      hasLiveRequest: false,
      workspace: null,
      versions: [],
      lastRequestFailed: false,
    });
    expect(result.step).toBe(1);
    expect(result.canGenerate).toBe(false);
    expect(result.canApprove).toBe(false);
    expect(result.selectedVersionId).toBeNull();
    expect(result.maxStepReached).toBe(1);
  });

  it("resolves saved draft with no versions to Step 2", () => {
    const result = resolveAuthoritativeStep({
      hasLiveRequest: false,
      workspace: { revision: 1, lastSubmittedRevision: null },
      versions: [],
      lastRequestFailed: false,
    });
    expect(result.step).toBe(2);
    expect(result.canGenerate).toBe(true);
    expect(result.maxStepReached).toBe(2);
  });

  it("resolves live request to Step 3 with Generate disabled", () => {
    const result = resolveAuthoritativeStep({
      hasLiveRequest: true,
      workspace: { revision: 1, lastSubmittedRevision: 1 },
      versions: [],
      lastRequestFailed: false,
    });
    expect(result.step).toBe(3);
    expect(result.canGenerate).toBe(false);
    expect(result.maxStepReached).toBe(3);
  });

  it("proves C5: edited draft after failed run resolves to Step 2 (old failure cannot trap new draft)", () => {
    // Failed run submitted at revision 1; user made new edit and saved at revision 2
    const result = resolveAuthoritativeStep({
      hasLiveRequest: false,
      workspace: { revision: 2, lastSubmittedRevision: 1 },
      versions: [],
      lastRequestFailed: true,
    });
    expect(result.step).toBe(2);
    expect(result.canGenerate).toBe(true);
    expect(result.maxStepReached).toBe(3);
  });

  it("resolves unedited draft after failed run to Step 3", () => {
    const result = resolveAuthoritativeStep({
      hasLiveRequest: false,
      workspace: { revision: 1, lastSubmittedRevision: 1 },
      versions: [],
      lastRequestFailed: true,
    });
    expect(result.step).toBe(3);
    expect(result.canGenerate).toBe(false);
  });

  it("resolves published version to Step 4 selecting approved version", () => {
    const result = resolveAuthoritativeStep({
      hasLiveRequest: false,
      workspace: { revision: 2, lastSubmittedRevision: 2 },
      versions: sampleVersions,
      lastRequestFailed: false,
    });
    expect(result.step).toBe(4);
    expect(result.selectedVersionId).toBe("ver-1");
    expect(result.maxStepReached).toBe(4);
  });

  it("resolves explicit owned version URL hint to Step 4 inspect mode", () => {
    const result = resolveAuthoritativeStep({
      requestedVersionId: "ver-2",
      hasLiveRequest: false,
      workspace: { revision: 2, lastSubmittedRevision: 2 },
      versions: sampleVersions,
      lastRequestFailed: false,
    });
    expect(result.step).toBe(4);
    expect(result.selectedVersionId).toBe("ver-2");
    expect(result.isInspectMode).toBe(true);
    expect(result.canApprove).toBe(true); // ver-2 is AWAITING_REVIEW
  });

  it("proves §5 precedence: explicit owned version URL wins over coexisting live request", () => {
    const result = resolveAuthoritativeStep({
      requestedVersionId: "ver-1",
      hasLiveRequest: true,
      workspace: { revision: 3, lastSubmittedRevision: 3 },
      versions: sampleVersions,
      lastRequestFailed: false,
    });
    expect(result.step).toBe(4);
    expect(result.selectedVersionId).toBe("ver-1");
    expect(result.isInspectMode).toBe(true);
    expect(result.canGenerate).toBe(false);
  });

  it("proves C6: Step 1 or 2 inspection while live creates no second work (canGenerate: false)", () => {
    const step1Result = resolveAuthoritativeStep({
      requestedStep: 1,
      hasLiveRequest: true,
      workspace: { revision: 1, lastSubmittedRevision: 1 },
      versions: [],
      lastRequestFailed: false,
    });
    expect(step1Result.step).toBe(1);
    expect(step1Result.isInspectMode).toBe(true);
    expect(step1Result.canGenerate).toBe(false);

    const step2Result = resolveAuthoritativeStep({
      requestedStep: 2,
      hasLiveRequest: true,
      workspace: { revision: 1, lastSubmittedRevision: 1 },
      versions: [],
      lastRequestFailed: false,
    });
    expect(step2Result.step).toBe(2);
    expect(step2Result.isInspectMode).toBe(true);
    expect(step2Result.canGenerate).toBe(false);
  });

  it("proves C6: direct ?step=4 with no versions disables approval", () => {
    const result = resolveAuthoritativeStep({
      requestedStep: 4,
      hasLiveRequest: false,
      workspace: null,
      versions: [],
      lastRequestFailed: false,
    });
    expect(result.step).toBe(4);
    expect(result.selectedVersionId).toBeNull();
    expect(result.canApprove).toBe(false);
  });
});
