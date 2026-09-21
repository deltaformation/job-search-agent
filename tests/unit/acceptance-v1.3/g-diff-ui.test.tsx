import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Step4Diff from "../../../components/tailoring/Step4Diff";
import Step4Review from "../../../components/tailoring/Step4Review";
import type { WorkflowReviewSegment } from "../../../src/domain/workflowReview";

/**
 * WO-1.3-G UI acceptance: G6 (escaped hostile HTML, non-color
 * markers, excluded rendering, changed-only filter, full-text
 * fallback), G5 (baseline-unavailable label), G7 (DOCX preview
 * disclaimer). Step4Review legs mock the review GET with canned
 * exact-version views.
 */

function segment(overrides: Partial<WorkflowReviewSegment> & { text: string }): WorkflowReviewSegment {
  return {
    segmentId: "seg-1",
    kind: "bullet",
    roleId: "role-1",
    textHash: "0".repeat(64),
    provenance: "VERIFIED_SOURCE",
    sourceOperationId: null,
    anchorFactIds: [],
    priorityIds: [],
    ...overrides,
  };
}

describe("G6 diff rendering", () => {
  it("renders hostile HTML as inert text with non-color markers", () => {
    const hostile = `<script>alert("x")</script><img src=x onerror=alert(1)>`;
    const { container } = render(
      <Step4Diff masterText="safe" tailoredText={hostile} segments={[]} excludedTexts={[]} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(hostile)).toBeDefined();
    expect(screen.getByText(/markers: = same, - removed, \+ added, ~ changed/)).toBeDefined();
  });

  it("tags attributed lines and marks excluded content excluded", () => {
    const accepted = segment({
      segmentId: "seg-acc",
      text: "Accepted AI bullet text.",
      provenance: "USER_ACCEPTED_AI",
      sourceOperationId: "op-acc",
    });
    render(
      <Step4Diff
        masterText={"## Experience\n\n- Kept bullet\n- Dropped bullet\n"}
        tailoredText={"## Experience\n\n- Kept bullet\n- Accepted AI bullet text.\n"}
        segments={[accepted]}
        excludedTexts={["Dropped bullet"]}
      />,
    );
    expect(screen.getByTitle("AI suggestion accepted").textContent).toBe("A");
    expect(screen.getByTitle("Removed by an explicit exclude operation").textContent).toBe("Excl");
    // The accepted line links its source operation.
    expect(screen.getByTitle("Source operation op-acc")).toBeDefined();
  });

  it("filters to changed sections without losing the filter control", () => {
    render(
      <Step4Diff
        masterText={"## Alpha\n\nsame\n\n## Beta\n\nold\n"}
        tailoredText={"## Alpha\n\nsame\n\n## Beta\n\nnew\n"}
        segments={[]}
        excludedTexts={[]}
      />,
    );
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Changed only"));
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getAllByText("Beta").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("All lines"));
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
  });

  it("falls back to complete texts over the line cap", () => {
    const masterText = Array.from({ length: 10_001 }, (_, i) => `master line ${i}`).join("\n");
    render(
      <Step4Diff masterText={masterText} tailoredText="one" segments={[]} excludedTexts={[]} />,
    );
    expect(screen.getByText("Line diff unavailable for this size.")).toBeDefined();
    expect(screen.getByText(/nothing is truncated/)).toBeDefined();
    // Both complete sides render (spot-check first/last master lines).
    expect(screen.getByText(/master line 0/)).toBeDefined();
    expect(screen.getByText(/master line 10000/)).toBeDefined();
    expect(screen.getByText("one")).toBeDefined();
  });
});

const LEGACY_VIEW = {
  job: { id: "job-1", status: "NEW", rowVersion: 1 },
  version: { id: "v-1", version: 1 },
  artifacts: [],
  workflowReview: {
    schemaVersion: "workflow-review/v2",
    format: "legacy",
    version: {
      id: "v-1",
      version: 1,
      reviewState: "AWAITING_REVIEW",
      parentVersionId: null,
      contentHash: "c".repeat(64),
      createdAt: "2026-09-16T12:00:00.000Z",
    },
    request: null,
    profile: null,
    parent: null,
    master: null,
    summaryOrigin: null,
    summaryText: null,
    operations: [],
    validation: null,
    policies: {
      templateId: "classic",
      templateVersion: "1",
      rankerVersion: "ranker/1",
      policyVersion: "policy/1",
      configVersion: "config/1",
      renderSchemaVersion: "render/1",
    },
    segments: [],
    excludedTexts: [],
    focus: { kind: "legacy" },
    assessment: null,
    assessmentLineage: null,
    insights: [
      {
        id: "keyword-coverage",
        kind: "keyword-coverage",
        text: "Keyword matches: not assessed (this version predates assessment).",
        citations: { priorityIds: [], requirementIds: [], segmentIds: [], checkIds: [] },
      },
    ],
    allowedActions: {
      approve: true,
      decline: true,
      revise: false,
      newVersion: true,
      reason: null,
    },
    markers: {
      latestPublished: true,
      selectedApproved: false,
      isApplicationVersion: false,
      appliedAt: null,
    },
    tailoredText: "",
    tailoredTextStatus: "unchecked",
  },
};

const DOCX_VIEW = {
  ...LEGACY_VIEW,
  artifacts: [
    {
      id: "art-docx",
      kind: "DOCX",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      byteSize: 10,
      sha256: "d".repeat(64),
    },
  ],
};

describe("Step4Review labels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubReview(view: unknown): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(view), { status: 200 })),
    );
  }

  const versions = [
    {
      id: "v-1",
      version: 1,
      reviewState: "AWAITING_REVIEW",
      selectedApproved: false,
      latestPublished: true,
    },
  ] as never;

  it("G5: labels a missing legacy baseline without substituting", async () => {
    stubReview(LEGACY_VIEW);
    render(
      <Step4Review jobId="job-1" versions={versions} initialVersionId="v-1" onNavigateStep={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText("Resume Version 1")).toBeDefined());
    expect(screen.getAllByText(/baseline unavailable/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/never substituted/i)).toBeDefined();
  });

  it("G7: marks the DOCX preview as not pixel-identical", async () => {
    stubReview(DOCX_VIEW);
    render(
      <Step4Review jobId="job-1" versions={versions} initialVersionId="v-1" onNavigateStep={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText("Resume Version 1")).toBeDefined());
    expect(screen.getByText(/not pixel-identical/i)).toBeDefined();
  });

  it("G11: previous-format revisions keep the immediate run, never the v2 editor", async () => {
    stubReview({
      ...LEGACY_VIEW,
      workflowReview: {
        ...(LEGACY_VIEW.workflowReview as Record<string, unknown>),
        format: "focus",
        allowedActions: {
          approve: true,
          decline: true,
          revise: true,
          newVersion: true,
          reason: null,
        },
      },
    });
    render(
      <Step4Review jobId="job-1" versions={versions} initialVersionId="v-1" onNavigateStep={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText("Resume Version 1")).toBeDefined());
    fireEvent.click(screen.getByText("Request changes"));
    expect(screen.getByText("Request revision run")).toBeDefined();
    expect(screen.queryByText("Continue to editor")).toBeNull();
  });
});
