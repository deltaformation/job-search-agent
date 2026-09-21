// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DecideBody,
  DeclineBody,
  FocusV1,
  GenerateBody,
  MOCKUP_REFERENCE_ROUTE,
  PRODUCTION_TAILOR_ROUTE_PATTERN,
  RetryBody,
  V13_TRANSACTION_BINDINGS,
  WorkspacePut,
} from "../../../src/domain/tailoringWorkspace";

/**
 * A2: contract tests bind W/G/R/A/D to named service owners and
 * ADR-015/017/018/019, and prove the full-page routing,
 * older-version eligibility, and immutable-baseline decisions carry
 * no contradictory action semantics.
 */

describe("A2 transaction ownership and ADR bindings", () => {
  it("binds W/G/R/A/D to exactly one owning order each", () => {
    expect(V13_TRANSACTION_BINDINGS.W.owner).toBe("WO-1.3-B");
    expect(V13_TRANSACTION_BINDINGS.G.owner).toBe("WO-1.3-E");
    expect(V13_TRANSACTION_BINDINGS.R.owner).toBe("WO-1.3-F");
    expect(V13_TRANSACTION_BINDINGS.A.owner).toBe("WO-1.3-G");
    expect(V13_TRANSACTION_BINDINGS.D.owner).toBe("WO-1.3-G");
  });

  it("names the service each owner must implement or refactor", () => {
    expect(V13_TRANSACTION_BINDINGS.W.service).toMatch(/tailoringWorkspace/);
    expect(V13_TRANSACTION_BINDINGS.G.service).toMatch(/requestGeneration\/requestRevision/);
    expect(V13_TRANSACTION_BINDINGS.R.service).toMatch(/requeueWorkItem/);
    expect(V13_TRANSACTION_BINDINGS.A.service).toMatch(/approveResume/);
    expect(V13_TRANSACTION_BINDINGS.D.service).toMatch(/declineVersion/);
  });

  it("governs generation by explicit-request ADRs and review by pointer ADRs", () => {
    expect(V13_TRANSACTION_BINDINGS.G.adrs).toEqual(
      expect.arrayContaining(["R-ADR-015", "R-ADR-017"]),
    );
    expect(V13_TRANSACTION_BINDINGS.R.adrs).toEqual(
      expect.arrayContaining(["R-ADR-015", "R-ADR-017"]),
    );
    expect(V13_TRANSACTION_BINDINGS.A.adrs).toEqual(expect.arrayContaining(["R-ADR-018"]));
    expect(V13_TRANSACTION_BINDINGS.D.adrs).toEqual(expect.arrayContaining(["R-ADR-019"]));
  });
});

describe("A2 routing, eligibility, and baseline decisions", () => {
  it("routes production tailoring to the full page, never the mockup reference", () => {
    expect(PRODUCTION_TAILOR_ROUTE_PATTERN).toBe("/jobs/[id]/tailor");
    expect(MOCKUP_REFERENCE_ROUTE).toBe("/mockup");
    expect(PRODUCTION_TAILOR_ROUTE_PATTERN).not.toContain("mockup");
  });

  it("keeps NEW_VERSION and REVISION parents distinct so older versions stay addressable", () => {
    const parent = "00000000-0000-4000-8000-000000000005";
    const base = {
      schemaVersion: "tailoring-workspace/v1",
      extractionId: null,
      profileId: null,
      profileVersionId: null,
      recommendationHash: null,
      focus: FocusV1.parse({
        schemaVersion: "tailoring-focus/v1",
        selectedPhraseIds: [],
        themeId: null,
        summaryDirection: "",
        mappings: [],
        additionalGuidance: "",
      }),
    } as const;
    // NEW_VERSION carries a parent without a note; REVISION carries both.
    expect(
      WorkspacePut.safeParse({
        ...base,
        requestKind: "NEW_VERSION",
        parentVersionId: parent,
        revisionNote: null,
      }).success,
    ).toBe(true);
    expect(
      WorkspacePut.safeParse({
        ...base,
        requestKind: "REVISION",
        parentVersionId: parent,
        revisionNote: "Tighten the routing bullet.",
      }).success,
    ).toBe(true);
    // An approved/declined parent can never ride a REVISION note.
    expect(
      WorkspacePut.safeParse({
        ...base,
        requestKind: "NEW_VERSION",
        parentVersionId: parent,
        revisionNote: "note",
      }).success,
    ).toBe(false);
  });

  it("gives generation and review disjoint request shapes with no shared mutable field", () => {
    const generate = GenerateBody.parse({
      schemaVersion: "tailoring-submit/v1",
      requestId: "00000000-0000-4000-8000-000000000004",
      workspaceRevision: 2,
      observedRowVersion: 3,
    });
    const retry = RetryBody.parse({
      schemaVersion: "tailoring-retry/v1",
      observedAttemptId: "00000000-0000-4000-8000-000000000006",
      observedRowVersion: 3,
    });
    // Generate submits a workspace revision; retry names an attempt; neither names a version.
    expect("resumeVersionId" in generate).toBe(false);
    expect("resumeVersionId" in retry).toBe(false);
    expect("workspaceRevision" in retry).toBe(false);
    const approve = DecideBody.parse({
      resumeVersionId: "00000000-0000-4000-8000-000000000008",
      observedRowVersion: 3,
    });
    const decline = DeclineBody.parse({
      resumeVersionId: "00000000-0000-4000-8000-000000000008",
      observedRowVersion: 3,
      note: "Stale JD.",
    });
    // Review names an exact version; neither review body can start work.
    expect("requestId" in approve).toBe(false);
    expect("workspaceRevision" in decline).toBe(false);
  });

  it("requires a decline reason while leaving the approval note optional", () => {
    const target = {
      resumeVersionId: "00000000-0000-4000-8000-000000000008",
      observedRowVersion: 3,
    };
    expect(DecideBody.safeParse(target).success).toBe(true);
    expect(DeclineBody.safeParse(target).success).toBe(false);
    expect(DeclineBody.safeParse({ ...target, note: "Wrong role emphasis." }).success).toBe(true);
  });
});
