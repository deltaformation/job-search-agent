import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TailorEntryPanel from "../../../../components/board/TailorEntryPanel";

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const VERSIONS = [
  {
    id: "ver-1",
    version: 1,
    reviewState: "APPROVED",
    profileDisplayName: "Product Manager",
    profileName: "pm",
  },
  {
    id: "ver-2",
    version: 2,
    reviewState: "AWAITING_REVIEW",
    profileDisplayName: "Product Manager",
    profileName: "pm",
  },
];

function stubStep2(preparation: unknown, workspace: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/jobs/job-1/tailoring/preparation") {
        return okJson(preparation);
      }
      if (url === "/api/jobs/job-1/tailoring/workspace") {
        return okJson(workspace);
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

const PREP_ABSENT = { preparation: { state: "ABSENT", acceptedPlanId: null, failure: null } };
const WS_ABSENT = { workspace: null };

describe("TailorEntryPanel (H1)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes the editing state with a Step 2 deep link", async () => {
    stubStep2(
      { preparation: { state: "SUCCEEDED", acceptedPlanId: "plan-1", failure: null } },
      {
        workspace: {
          revision: 3,
          lastSubmittedRevision: 2,
          draft: { schemaVersion: "tailoring-workspace/v3", draft: { operations: [] } },
        },
      },
    );
    render(
      <TailorEntryPanel
        jobId="job-1"
        tailoringState="READY"
        tailoringReasonCode={null}
        tailorLive={false}
        versions={VERSIONS}
      />,
    );
    expect(await screen.findByText("Editing draft")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /continue editing in step 2/i });
    expect(link).toHaveAttribute("href", "/jobs/job-1/tailor?step=2");
  });

  it("exposes blocked-with-reason with the failure code", async () => {
    stubStep2(
      {
        preparation: {
          state: "FAILED",
          acceptedPlanId: null,
          failure: { code: "PROVIDER_TIMEOUT" },
        },
      },
      WS_ABSENT,
    );
    render(
      <TailorEntryPanel
        jobId="job-1"
        tailoringState="READY"
        tailoringReasonCode={null}
        tailorLive={false}
        versions={[]}
      />,
    );
    expect(await screen.findByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText("PROVIDER_TIMEOUT")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /resolve the block in step 2/i })).toHaveAttribute(
      "href",
      "/jobs/job-1/tailor?step=2",
    );
  });

  it("links exact per-version review contexts across v1/v2 rows", async () => {
    stubStep2(PREP_ABSENT, WS_ABSENT);
    render(
      <TailorEntryPanel
        jobId="job-1"
        tailoringState="AWAITING_REVIEW"
        tailoringReasonCode={null}
        tailorLive={false}
        versions={VERSIONS}
      />,
    );
    expect(await screen.findByText("Resume versions (2)")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Review version 1 in the tailor flow" }),
    ).toHaveAttribute("href", "/jobs/job-1/tailor?step=4&version=ver-1");
    expect(
      screen.getByRole("link", { name: "Review version 2 in the tailor flow" }),
    ).toHaveAttribute("href", "/jobs/job-1/tailor?step=4&version=ver-2");
  });

  it("degrades honestly when Step 2 reads fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    render(
      <TailorEntryPanel
        jobId="job-1"
        tailoringState="READY"
        tailoringReasonCode={null}
        tailorLive={false}
        versions={VERSIONS}
      />,
    );
    expect(await screen.findByText(/step 2 status unavailable/i)).toBeInTheDocument();
    // The flow link and version links still resolve from detail data.
    expect(screen.getByRole("link", { name: /start tailoring in step 1/i })).toHaveAttribute(
      "href",
      "/jobs/job-1/tailor?step=1",
    );
    expect(
      screen.getByRole("link", { name: "Review version 2 in the tailor flow" }),
    ).toBeInTheDocument();
  });
});
