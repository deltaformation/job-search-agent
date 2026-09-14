import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobDetailView } from "../../../../src/server/board";
import CardDrawer from "../../../../components/board/CardDrawer";

function detailView(): JobDetailView {
  return {
    job: {
      id: "job-1",
      status: "TAILORED",
      rank: 0,
      rowVersion: 2,
      title: "Staff Engineer",
      company: "Gamma LLC",
      location: "Remote",
      arrangement: "REMOTE",
      salaryText: "$200k",
      salaryCurrency: null,
      salaryMinMinor: null,
      salaryMaxMinor: null,
      descriptionText: "Lead things.",
      postedAt: null,
      scrapeState: "SUCCEEDED",
      scrapeReasonCode: null,
      tailoringState: "PENDING",
      tailoringReasonCode: null,
      activeExtractionId: "ext-1",
      activeResumeVersionId: null,
      createdAt: "2026-09-11T10:00:00.000Z",
      updatedAt: "2026-09-11T11:00:00.000Z",
    },
    source: {
      submittedUrl: "https://example.com/jobs/1",
      canonicalUrl: "https://example.com/jobs/1",
      finalUrl: null,
      applyUrl: null,
      sourceIdentity: null,
    },
    attempts: [
      {
        id: "att-1",
        startedAt: "2026-09-11T10:00:00.000Z",
        finishedAt: "2026-09-11T10:00:05.000Z",
        outcome: "SUCCEEDED",
        reasonCode: null,
        errorDetail: null,
        workerId: "clip",
        adapter: "generic",
        createdAt: "2026-09-11T10:00:05.000Z",
      },
    ],
    tailoringAttempt: null,
    artifacts: [
      { id: "art-1", attemptId: "att-1", kind: "HTML", mediaType: "text/html", byteSize: 99, sha256: "a" },
    ],
    compensationHighlights: [],
    topKeywords: [],
    extraction: {
      id: "ext-1",
      adapter: "generic",
      adapterVersion: null,
      confidence: 0.8,
      missingFields: ["postedAt"],
      contentHash: "b",
      fields: { title: "Staff Engineer" },
      provenance: { title: "generic:h1" },
    },
    resumes: [],
    notes: [{ id: "note-1", body: "<b>call back</b>", createdAt: "2026-09-11T11:00:00.000Z", updatedAt: "2026-09-11T11:00:00.000Z" }],
    application: null,
    history: [
      {
        id: "ev-1",
        actor: "human",
        fromStatus: "NEW",
        toStatus: "TAILORED",
        rank: 0,
        rowVersion: 2,
        reason: "approval",
        metadata: {
          schemaVersion: "workflow-event-metadata-v1",
          resumeVersionId: "00000000-0000-0000-0000-000000000001",
          reviewId: "00000000-0000-0000-0000-000000000002",
        },
        createdAt: "2026-09-11T10:30:00.000Z",
      },
    ],
    intake: { batchId: "batch-1", lineNumber: 1, rawInput: "https://example.com/jobs/1" },
  };
}

function okJson(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload };
}

describe("CardDrawer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderDrawer() {
    const fetchMock = vi.fn().mockResolvedValue(okJson(detailView()));
    vi.stubGlobal("fetch", fetchMock);
    const props = {
      jobId: "job-1",
      refreshToken: 0,
      onClose: vi.fn(),
      onChanged: vi.fn(),
      onCorrect: vi.fn(),
      onApplied: vi.fn(),
      onReject: vi.fn(),
    };
    const rendered = render(<CardDrawer {...props} />);
    return { fetchMock, props, container: rendered.container };
  }

  it("renders every section and escapes untrusted markup", async () => {
    const { container } = renderDrawer();
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    expect(screen.getByText("Gamma LLC · Remote")).toBeInTheDocument();
    expect(screen.getByText(/missing/i)).toBeInTheDocument();
    expect(screen.getByText(/postedAt/)).toBeInTheDocument();

    const originals = screen.getAllByRole("link", { name: /open original/i });
    expect(originals).toHaveLength(2);
    expect(originals[0]).toHaveAttribute("href", "https://example.com/jobs/1");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Notes & Timeline" }), { button: 0, ctrlKey: false });
    expect(screen.getByText(/html evidence/i)).toBeInTheDocument();
    expect(screen.getByText(/NEW → TAILORED/)).toBeInTheDocument();
    // The note body renders as text, never as markup.
    expect(screen.getByText("<b>call back</b>")).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
  });

  it("places identity and tabs in the header with status and actions beside the content", async () => {
    renderDrawer();
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    // Fixed header order: section tabs precede the active panel in the page.
    const tablist = screen.getByRole("tablist", { name: "Card sections" });
    const panel = screen.getByRole("tabpanel");
    expect(tablist.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Context sidebar: status rows keep the contiguous pipeline hook.
    const status = screen.getByRole("region", { name: "Status" });
    expect(status).toHaveTextContent("Status: TAILORED");
    expect(status).toHaveTextContent("Scrape: Succeeded");
    expect(status).toHaveTextContent("Tailoring: Pending");
    // Context sidebar: actions keep their label and button bindings.
    const actions = screen.getByRole("region", { name: "Card actions" });
    expect(within(actions).getByLabelText("Move to")).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: /^move$/i })).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: /correct \/ reopen/i })).toBeInTheDocument();
  });

  it("resets section scroll to the top when switching tabs", async () => {
    renderDrawer();
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    const main = document.querySelector(".workspace-main") as HTMLElement;
    const center = document.querySelector(".workspace-center") as HTMLElement;
    main.scrollTop = 500;
    center.scrollTop = 500;
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Notes & Timeline" }), { button: 0, ctrlKey: false });
    expect(main.scrollTop).toBe(0);
    expect(center.scrollTop).toBe(0);
  });

  it("moves within the ordinary graph and opens dialogs for the rest", async () => {
    const { fetchMock, props } = renderDrawer();
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    // TAILORED offers APPLIED (modal) and REJECTED (dialog).
    fireEvent.change(screen.getByLabelText("Move to"), { target: { value: "APPLIED" } });
    fireEvent.click(screen.getByRole("button", { name: /^move$/i }));
    expect(props.onApplied).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1", rowVersion: 2 }),
      0,
    );
    fireEvent.change(screen.getByLabelText("Move to"), { target: { value: "REJECTED" } });
    fireEvent.click(screen.getByRole("button", { name: /^move$/i }));
    expect(props.onReject).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /correct \/ reopen/i }));
    expect(props.onCorrect).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("posts direct moves and notes, then refreshes", async () => {
    const applied = { ...detailView(), job: { ...detailView().job, status: "APPLIED" as const } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(applied))
      .mockResolvedValueOnce(okJson({ ok: true, newRowVersion: 3 }))
      .mockResolvedValueOnce(okJson(applied))
      .mockResolvedValueOnce(okJson({ ok: true, noteId: "note-2" }))
      .mockResolvedValue(okJson(applied));
    vi.stubGlobal("fetch", fetchMock);
    const props = {
      jobId: "job-1",
      refreshToken: 0,
      onClose: vi.fn(),
      onChanged: vi.fn(),
      onCorrect: vi.fn(),
      onApplied: vi.fn(),
      onReject: vi.fn(),
    };
    render(<CardDrawer {...props} />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Move to"), { target: { value: "INTERVIEWED" } });
    fireEvent.click(screen.getByRole("button", { name: /^move$/i }));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/jobs/job-1/move");

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Notes & Timeline" }), { button: 0, ctrlKey: false });
    fireEvent.change(screen.getByLabelText("Add a note"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: /^add note$/i }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4));
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/jobs/job-1/notes");
  });
});

describe("CardDrawer tailoring status", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function drawerProps() {
    return {
      jobId: "job-1",
      refreshToken: 0,
      onClose: vi.fn(),
      onChanged: vi.fn(),
      onCorrect: vi.fn(),
      onApplied: vi.fn(),
      onReject: vi.fn(),
    };
  }

  function failedView(): JobDetailView {
    const base = detailView();
    return {
      ...base,
      job: { ...base.job, tailoringState: "FAILED", tailoringReasonCode: "PROVIDER_UNAVAILABLE" },
      tailoringAttempt: {
        result: "FAILED",
        errorCode: "PROVIDER_UNAVAILABLE",
        errorDetail: "OpenRouter rate limit reached (HTTP 429): wait for quota, then retry",
        startedAt: "2026-09-11T12:00:00.000Z",
        finishedAt: "2026-09-11T12:00:30.000Z",
      },
    };
  }

  function runningView(): JobDetailView {
    const base = detailView();
    return {
      ...base,
      job: { ...base.job, tailoringState: "RUNNING", tailoringReasonCode: null },
      tailoringAttempt: null,
    };
  }

  function reviewPayload() {
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
      analysis: null,
      claims: [],
      topKeywords: [],
      content: null,
      artifacts: [],
      reviews: [],
      actions: { canApprove: false, canRequestRevision: false, reason: "test fixture" },
    };
  }

  function landedView(): JobDetailView {
    const base = detailView();
    return {
      ...base,
      job: {
        ...base.job,
        tailoringState: "AWAITING_REVIEW",
        tailoringReasonCode: null,
        activeResumeVersionId: "ver-1",
      },
      resumes: [
        {
          id: "ver-1",
          version: 1,
          parentVersionId: null,
          reviewState: "AWAITING_REVIEW",
          contentHash: "c".repeat(64),
          createdAt: "2026-09-11T12:00:00.000Z",
          artifacts: [],
          reviews: [],
        },
      ],
    };
  }

  function openResumesTab(): void {
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Tailoring & Resumes" }), {
      button: 0,
      ctrlKey: false,
    });
  }

  it("shows the failure alert with detail and retries the run", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return okJson({ workItemId: "work-1", action: "requeued" });
      }
      return okJson(fetchMock.mock.calls.filter(([u, i]) => u === "/api/jobs/job-1" && i?.method !== "POST").length <= 1 ? failedView() : runningView());
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = drawerProps();
    render(<CardDrawer {...props} />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    openResumesTab();
    expect(await screen.findByText(/tailoring failed/i)).toBeInTheDocument();
    expect(screen.getByText(/rate limit reached \(HTTP 429\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry tailoring/i }));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe("/api/jobs/job-1/tailor/retry");
    expect(await screen.findByText(/tailoring restarted/i)).toBeInTheDocument();
  });

  it("surfaces retry failures instead of hanging", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return { ok: false, status: 400, json: async () => ({ error: "extraction incomplete" }) };
      }
      return okJson(failedView());
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CardDrawer {...drawerProps()} />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    openResumesTab();
    expect(await screen.findByText(/tailoring failed/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry tailoring/i }));
    expect(await screen.findByText(/extraction incomplete/i)).toBeInTheDocument();
  });

  it("polls while the run is live and lands the review on its own", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.startsWith("/api/resumes/")) {
          return okJson(reviewPayload());
        }
        return okJson(fetchMock.mock.calls.filter(([u]) => u === "/api/jobs/job-1").length <= 1 ? runningView() : landedView());
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<CardDrawer {...drawerProps()} />);
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        expect(screen.getByText("Staff Engineer")).toBeInTheDocument();
      });
      openResumesTab();
      expect(screen.getByText(/tailoring in progress/i)).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      // The poll landed a version: the review renders without a refresh.
      expect(screen.getByText(/1 version generated/)).toBeInTheDocument();
      expect(screen.queryByText(/tailoring in progress/i)).not.toBeInTheDocument();
      const settledCalls = fetchMock.mock.calls.filter(([u]) => u === "/api/jobs/job-1").length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      // Settled: polling stopped.
      expect(fetchMock.mock.calls.filter(([u]) => u === "/api/jobs/job-1").length).toBe(settledCalls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ticks the elapsed clock while RUNNING", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => okJson(runningView()));
      vi.stubGlobal("fetch", fetchMock);
      render(<CardDrawer {...drawerProps()} />);
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        expect(screen.getByText("Staff Engineer")).toBeInTheDocument();
      });
      openResumesTab();
      expect(screen.getByText(/0s elapsed/)).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(screen.getByText(/3s elapsed/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the queued banner while PENDING", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson(detailView()));
    vi.stubGlobal("fetch", fetchMock);
    render(<CardDrawer {...drawerProps()} />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    openResumesTab();
    expect(await screen.findByText(/queued for tailoring/i)).toBeInTheDocument();
  });

  it("shows formatted salary, highlights, and keyword chips", async () => {
    const base = detailView();
    const view: JobDetailView = {
      ...base,
      job: {
        ...base.job,
        salaryText: "$145,900 - $197,400 CAD per year",
        salaryCurrency: "CAD",
        salaryMinMinor: 14590000,
        salaryMaxMinor: 19740000,
      },
      compensationHighlights: ["RRSP matching", "Equity"],
      topKeywords: [
        { keyword: "TypeScript API experience", evidenced: true },
        { keyword: "Kubernetes deployment", evidenced: false },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(okJson(view));
    vi.stubGlobal("fetch", fetchMock);
    render(<CardDrawer {...drawerProps()} />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    expect(screen.getByText("$145,900 – $197,400 CAD")).toBeInTheDocument();
    expect(screen.getByText("Compensation highlights")).toBeInTheDocument();
    expect(screen.getByText("RRSP matching")).toBeInTheDocument();
    expect(screen.getByText("Top 5 ATS keywords")).toBeInTheDocument();
    expect(screen.getByText("Evidenced in resume")).toBeInTheDocument();
    expect(screen.getByText("Gaps — not on resume")).toBeInTheDocument();
  });

  it("hides highlights and keywords when none are reported", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson(detailView()));
    vi.stubGlobal("fetch", fetchMock);
    render(<CardDrawer {...drawerProps()} />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Compensation highlights")).toBeNull();
    expect(screen.queryByText("Top 5 ATS keywords")).toBeNull();
  });

  describe("tailoring guidance", () => {
    const guideProfiles = [
      { id: "profile-1", name: "staff-engineer", displayName: "Staff Engineer", isDefault: true },
      { id: "profile-2", name: "manager", displayName: "Manager", isDefault: false },
    ];

    function guidedView(): JobDetailView {
      const base = failedView();
      return {
        ...base,
        job: {
          ...base.job,
          descriptionText:
            "Senior platform role. Kubernetes and PostgreSQL required. " +
            "Kubernetes experience required. PostgreSQL required. AWS preferred. " +
            "Lead the team to production excellence.",
        },
      };
    }

    function setupGuidance(options: {
      view?: JobDetailView;
      onPost?: (url: string) => unknown;
    } = {}) {
      const view = options.view ?? guidedView();
      const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        if (url === "/api/settings/profiles") {
          return okJson({ profiles: guideProfiles });
        }
        if (url.startsWith("/api/resumes/")) {
          return okJson(reviewPayload());
        }
        if (init?.method === "POST") {
          return okJson(options.onPost?.(url) ?? { workItemId: "work-9", action: "enqueued" });
        }
        return okJson(view);
      });
      vi.stubGlobal("fetch", fetchMock);
      const props = drawerProps();
      render(<CardDrawer {...props} />);
      return { fetchMock, props };
    }

    it("renders profiles, keyword chips, and directive starters", async () => {
      setupGuidance();
      expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
      openResumesTab();
      expect(await screen.findByText("Tailoring Guidance")).toBeInTheDocument();
      const profileSelect = screen.getByLabelText("Career profile") as HTMLSelectElement;
      expect(profileSelect.options[0]?.text).toBe("Default profile");
      expect(profileSelect.options[1]?.text).toBe("Staff Engineer (default)");
      expect(profileSelect.options[2]?.text).toBe("Manager");
      const kubernetes = screen.getByRole("button", { name: "Kubernetes" });
      expect(kubernetes).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(kubernetes);
      expect(screen.getByRole("button", { name: "✓ Kubernetes" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      fireEvent.click(screen.getByRole("button", { name: /Emphasize profile skills/ }));
      fireEvent.click(screen.getByRole("button", { name: /Prioritize B2B SaaS experience/ }));
      expect(screen.getByLabelText("Directive notes")).toHaveValue(
        "Emphasize profile skills\nPrioritize B2B SaaS experience",
      );
      expect(screen.getByRole("button", { name: /Tailor Resume/ })).toBeEnabled();
    });

    it("dispatches a guided run with profile, keywords, and directives", async () => {
      const { fetchMock, props } = setupGuidance();
      expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
      openResumesTab();
      expect(await screen.findByText("Tailoring Guidance")).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("Career profile"), {
        target: { value: "profile-2" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
      fireEvent.click(screen.getByRole("button", { name: "PostgreSQL" }));
      fireEvent.change(screen.getByLabelText("Directive notes"), {
        target: { value: "Emphasize scale." },
      });
      fireEvent.click(screen.getByRole("button", { name: "Tailor Resume" }));
      await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
      const post = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === "/api/jobs/job-1/tailor/retry" &&
          (init as { method?: string } | undefined)?.method === "POST",
      ) as [string, { body: string } | undefined] | undefined;
      expect(post).toBeDefined();
      expect(JSON.parse(post?.[1]?.body ?? "{}")).toEqual({
        profileId: "profile-2",
        selectedKeywords: ["Kubernetes", "PostgreSQL"],
        directives: "Emphasize scale.",
      });
      expect(await screen.findByText(/tailoring with your guidance/i)).toBeInTheDocument();
    });

    it("disables guided tailoring while a run is live", async () => {
      setupGuidance({ view: runningView() });
      expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
      openResumesTab();
      expect(await screen.findByText("Tailoring Guidance")).toBeInTheDocument();
      const button = screen.getByRole("button", { name: "Tailor Resume" });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", "A tailoring run is already in flight");
    });

    it("offers re-tailoring once resumes exist", async () => {
      setupGuidance({ view: landedView() });
      expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
      openResumesTab();
      expect(await screen.findByText("Tailoring Guidance")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Re-tailor Resume" })).toBeEnabled();
    });
  });
});
