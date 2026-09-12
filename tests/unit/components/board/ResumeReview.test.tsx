import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResumeReviewView } from "../../../../src/server/review";
import ResumeReview from "../../../../components/board/ResumeReview";

function reviewView(): ResumeReviewView {
  return {
    job: {
      id: "job-1",
      status: "NEW",
      rowVersion: 3,
      tailoringState: "AWAITING_REVIEW",
      activeResumeVersionId: "ver-1",
    },
    version: {
      id: "ver-1",
      jobId: "job-1",
      version: 1,
      parentVersionId: null,
      reviewState: "AWAITING_REVIEW",
      contentHash: "c".repeat(64),
      templateId: "standard",
      templateVersion: "v1",
      rankerVersion: "ranker-v1",
      policyVersion: "policy-v1",
      configVersion: "config-v1",
      renderSchemaVersion: "render-v1",
      createdAt: "2026-09-11T12:00:00.000Z",
    },
    analysis: {
      id: "ana-1",
      requirements: [
        {
          requirementId: "req_api",
          jdQuote: "TypeScript API experience",
          category: "skill",
          importance: "required",
          matchStatus: "matched",
          evidenceFactIds: ["f1"],
          reviewStatus: "confirmed",
        },
      ],
      gaps: [
        {
          requirementId: "req_k8s",
          jdQuote: "Kubernetes deployment",
          category: "skill",
          importance: "required",
          matchStatus: "gap",
        },
      ],
      rationale: "One supported, one gap.",
      provider: "test-provider",
      model: null,
      promptVersion: "tailor-prompt/v1",
    },
    claims: [
      {
        id: "claim-1",
        claimText: "Led the API migration to TypeScript.",
        requirementRef: "req_api",
        derivationKind: null,
        facts: [{ factId: "f1", statement: "Led the API migration.", kind: "experience" }],
      },
    ],
    topKeywords: [
      {
        keyword: "TypeScript API experience",
        requirementId: "req_api",
        category: "skill",
        importance: "required",
        evidenced: true,
        evidenceFactIds: ["f1"],
        placements: ["skills", "experience"],
      },
      {
        keyword: "Kubernetes deployment",
        requirementId: "req_k8s",
        category: "skill",
        importance: "required",
        evidenced: false,
        evidenceFactIds: [],
        placements: [],
      },
    ],
    content: {
      summaryStrategy: "fact-grounded",
      omittedUnsupported: ["Kubernetes"],
      changeSummary: {
        addedBullets: ["Led the API migration to TypeScript."],
        removedBullets: [],
        summaryChanged: true,
        baselineLines: 40,
        tailoredLines: 44,
      },
      audit: {
        requirementsTotal: 2,
        supportedCount: 1,
        gapCount: 1,
        validatedClaims: 1,
        totalClaims: 1,
        rationale: "One supported, one gap.",
        questions: [],
      },
    },
    artifacts: [
      { id: "art-md", kind: "MARKDOWN", mediaType: "text/markdown", byteSize: 120, sha256: "m".repeat(64) },
      { id: "art-docx", kind: "DOCX", mediaType: "application/docx", byteSize: 900, sha256: "d".repeat(64) },
      { id: "art-pdf", kind: "PDF", mediaType: "application/pdf", byteSize: 1500, sha256: "p".repeat(64) },
    ],
    reviews: [],
    actions: { canApprove: true, canRequestRevision: true, reason: null },
  };
}

function okJson(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload };
}

describe("ResumeReview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderReview(view: ResumeReviewView = reviewView()) {
    const posts: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        posts.push({ url, body: init.body === undefined ? null : (JSON.parse(init.body) as unknown) });
        return okJson({ ok: true, newRowVersion: 4 });
      }
      return okJson(view);
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = { versionId: "ver-1", refreshToken: 0, onChanged: vi.fn(), onReviewed: vi.fn() };
    const rendered = render(<ResumeReview {...props} />);
    return { fetchMock, posts, props, container: rendered.container };
  }

  it("renders proposal, evidence, gaps, claims, and files side by side", async () => {
    const { container } = renderReview();
    expect(await screen.findByText(/version 1 · awaiting review/i)).toBeInTheDocument();
    // Proposal column: the bullet appears both as an added change and as a claim.
    expect(screen.getAllByText("Led the API migration to TypeScript.")).toHaveLength(2);
    expect(screen.getByText(/resume claims \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/\[f1\] led the api migration\./i)).toBeInTheDocument();
    // Evidence column.
    expect(screen.getByText(/requirements \(1\)/i)).toBeInTheDocument();
    // Each quote appears twice: once in requirements/gaps, once in the Top-5 audit.
    expect(screen.getAllByText(/typescript api experience/i)).toHaveLength(2);
    expect(screen.getByText(/evidence: f1/i)).toBeInTheDocument();
    expect(screen.getByText(/gaps — not on the resume \(1\)/i)).toBeInTheDocument();
    expect(screen.getAllByText(/kubernetes deployment/i)).toHaveLength(2);
    expect(screen.getByText(/omitted unsupported terms: kubernetes/i)).toBeInTheDocument();
    // Files with preview and download links.
    const previews = screen.getAllByRole("link", { name: "Preview" });
    expect(previews).toHaveLength(3);
    expect(previews[0]).toHaveAttribute("href", "/api/resumes/artifacts/art-md");
    const downloads = screen.getAllByRole("link", { name: "Download" });
    expect(downloads[2]).toHaveAttribute("href", "/api/resumes/artifacts/art-pdf?download=1");
    expect(container.querySelector("img")).toBeNull();
  });

  it("escapes untrusted provider and page text", async () => {
    const hostile = reviewView();
    hostile.claims[0] = {
      ...hostile.claims[0]!,
      claimText: "<img src=x onerror=alert(1)> Led things.",
      facts: [{ factId: "f1", statement: "<b>bold fact</b>", kind: "experience" }],
    };
    hostile.analysis!.requirements[0] = {
      ...hostile.analysis!.requirements[0]!,
      jdQuote: "<script>alert(2)</script>",
    };
    const { container } = renderReview(hostile);
    expect(await screen.findByText(/led things\./i)).toBeInTheDocument();
    expect(screen.getByText("<img src=x onerror=alert(1)> Led things.")).toBeInTheDocument();
    expect(screen.getByText("<b>bold fact</b>", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("<script>alert(2)</script>", { exact: false })).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("approves through a two-step confirmation and refreshes", async () => {
    const { posts, props } = renderReview();
    expect(await screen.findByText(/version 1 · awaiting review/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /approve version 1/i }));
    // Confirmation summarizes the binding before anything is sent.
    expect(screen.getByText(/confirm approval of version 1/i)).toBeInTheDocument();
    expect(screen.getByText(/moves the card to tailored/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/approval note/i), { target: { value: "Checked." } });
    fireEvent.click(screen.getByRole("button", { name: /^confirm approval$/i }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.url).toBe("/api/jobs/job-1/resume/approve");
    expect(posts[0]?.body).toEqual({
      resumeVersionId: "ver-1",
      observedRowVersion: 3,
      note: "Checked.",
    });
    await waitFor(() => expect(screen.getByText(/approved — the card moved to tailored/i)).toBeInTheDocument());
    expect(props.onChanged).toHaveBeenCalled();
    expect(props.onReviewed).toHaveBeenCalled();
  });

  it("requests revision with a mandatory note", async () => {
    const { posts } = renderReview();
    expect(await screen.findByText(/version 1 · awaiting review/i)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: /^request revision$/i });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^request revision$/i), {
      target: { value: "Second bullet overstates the metric." },
    });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.url).toBe("/api/jobs/job-1/resume/revise");
    expect(posts[0]?.body).toEqual({
      resumeVersionId: "ver-1",
      observedRowVersion: 3,
      note: "Second bullet overstates the metric.",
    });
    await waitFor(() => expect(screen.getByText(/revision requested for version 1/i)).toBeInTheDocument());
  });

  it("shows the gate reason instead of actions for decided versions", async () => {
    const decided = reviewView();
    decided.version.reviewState = "APPROVED";
    decided.actions = {
      canApprove: false,
      canRequestRevision: false,
      reason: "This version is APPROVED; only versions awaiting review can be decided.",
    };
    renderReview(decided);
    expect(await screen.findByText(/only versions awaiting review can be decided/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve version/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^request revision$/i })).toBeNull();
  });

  it("audits top keywords with evidenced and gap states", async () => {
    renderReview();
    expect(await screen.findByText(/top 5 ats keywords & match audit/i)).toBeInTheDocument();
    expect(screen.getByText("Evidenced")).toBeInTheDocument();
    expect(screen.getByText("Gap — not on resume")).toBeInTheDocument();
    expect(screen.getByText(/woven into: skills, experience/i)).toBeInTheDocument();
    expect(screen.getByText(/honestly omitted from the resume/i)).toBeInTheDocument();
  });

  it("hides the keyword audit when the analysis is missing", async () => {
    const view = reviewView();
    view.topKeywords = [];
    renderReview(view);
    expect(await screen.findByText(/version 1 · awaiting review/i)).toBeInTheDocument();
    expect(screen.queryByText(/top 5 ats keywords & match audit/i)).toBeNull();
  });
});
