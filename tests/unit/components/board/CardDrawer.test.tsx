import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
      selectedResumeVersionId: null,
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
      retainedDescriptionText: null,
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

describe("CardDrawer tailor entry (WO-1.3-H)", () => {
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

  function readyView(): JobDetailView {
    const base = detailView();
    return {
      ...base,
      job: { ...base.job, tailoringState: "READY", tailoringReasonCode: null },
      tailoringAttempt: null,
    };
  }

  function blockedView(): JobDetailView {
    const base = detailView();
    return {
      ...base,
      job: { ...base.job, tailoringState: "BLOCKED", tailoringReasonCode: "NO_PROVIDER" },
      tailoringAttempt: null,
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
          profileName: "staff-engineer",
          profileDisplayName: "Staff Engineer",
          profileId: "profile-1",
          profileVersionId: "pv-1",
          profileVersionNumber: 2,
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

  function stubApi(detail: JobDetailView, prep: unknown, workspace: unknown) {
    const fetchMock = vi.fn(async (url: unknown, _init?: { method?: string }) => {
      const target = String(url);
      if (target.endsWith("/tailoring/preparation")) {
        return okJson(prep);
      }
      if (target.endsWith("/tailoring/workspace")) {
        return okJson(workspace);
      }
      return okJson(detail);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function failJson() {
    return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
  }

  it("shows the failed state with reason and a Step 3 deep link", async () => {
    stubApi(failedView(), { state: "ABSENT", acceptedPlanId: null, failure: null }, null);
    render(<CardDrawer {...drawerProps()} />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    openResumesTab();
    expect(await screen.findByText("Generation failed")).toBeInTheDocument();
    expect(screen.getByText("PROVIDER_UNAVAILABLE")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /open failure details in step 3/i });
    expect(link.getAttribute("href")).toBe("/jobs/job-1/tailor?step=3");
  });

  it("shows generating while a run is live with a Step 3 progress link", async () => {
    stubApi(runningView(), { state: "ABSENT", acceptedPlanId: null, failure: null }, null);
    render(<CardDrawer {...drawerProps()} />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    openResumesTab();
    expect(await screen.findByText("Generating")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /watch progress in step 3/i });
    expect(link.getAttribute("href")).toBe("/jobs/job-1/tailor?step=3");
  });

  it("shows blocked with the preparation failure reason and a Step 2 link", async () => {
    stubApi(
      blockedView(),
      { state: "FAILED", acceptedPlanId: null, failure: { code: "NO_PROVIDER" } },
      null,
    );
    render(<CardDrawer {...drawerProps()} />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    openResumesTab();
    expect(await screen.findByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText("NO_PROVIDER")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /resolve the block in step 2/i });
    expect(link.getAttribute("href")).toBe("/jobs/job-1/tailor?step=2");
  });

  it("shows editing while a draft revision is unsubmitted", async () => {
    stubApi(
      readyView(),
      { state: "SUCCEEDED", acceptedPlanId: null, failure: null },
      {
        workspace: {
          revision: 3,
          lastSubmittedRevision: 2,
          draft: { schemaVersion: "step2-draft/v2", draft: { focus: {} } },
        },
      },
    );
    render(<CardDrawer {...drawerProps()} />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    openResumesTab();
    expect(await screen.findByText("Editing draft")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /continue editing in step 2/i });
    expect(link.getAttribute("href")).toBe("/jobs/job-1/tailor?step=2");
  });

  it("shows prepared once a plan is accepted with no pending draft", async () => {
    stubApi(
      readyView(),
      { state: "SUCCEEDED", acceptedPlanId: "plan-1", failure: null },
      null,
    );
    render(<CardDrawer {...drawerProps()} />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    openResumesTab();
    expect(await screen.findByText("Prepared plan")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /review the prepared plan in step 2/i });
    expect(link.getAttribute("href")).toBe("/jobs/job-1/tailor?step=2");
  });

  it("shows not-started with a Step 1 link on a fresh job", async () => {
    stubApi(readyView(), { state: "ABSENT", acceptedPlanId: null, failure: null }, null);
    render(<CardDrawer {...drawerProps()} />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    openResumesTab();
    expect(await screen.findByText("Not started")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /start tailoring in step 1/i });
    expect(link.getAttribute("href")).toBe("/jobs/job-1/tailor?step=1");
  });

  it("links each resume version to its exact review context", async () => {
    stubApi(landedView(), { state: "ABSENT", acceptedPlanId: null, failure: null }, null);
    render(<CardDrawer {...drawerProps()} />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    openResumesTab();
    expect(await screen.findByText("Version 1")).toBeInTheDocument();
    const versionsSection = screen.getByText("Resume versions (1)").closest("section");
    expect(versionsSection).not.toBeNull();
    expect(
      within(versionsSection as HTMLElement).getByText("Awaiting review"),
    ).toBeInTheDocument();
    const link = within(versionsSection as HTMLElement).getByRole("link", {
      name: "Review version 1 in the tailor flow",
    });
    expect(link.getAttribute("href")).toBe("/jobs/job-1/tailor?step=4&version=ver-1");
  });

  it("guides empty versions toward Step 1", async () => {
    stubApi(readyView(), { state: "ABSENT", acceptedPlanId: null, failure: null }, null);
    render(<CardDrawer {...drawerProps()} />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    openResumesTab();
    expect(await screen.findByText(/no tailored resumes yet/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Start tailoring" });
    expect(link.getAttribute("href")).toBe("/jobs/job-1/tailor?step=1");
  });

  it("offers no drawer mutations: entry panels render links, never buttons, and issue only GETs", async () => {
    const fetchMock = stubApi(
      failedView(),
      { state: "ABSENT", acceptedPlanId: null, failure: null },
      null,
    );
    render(<CardDrawer {...drawerProps()} />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    openResumesTab();
    expect(await screen.findByText("Generation failed")).toBeInTheDocument();
    for (const heading of ["Tailoring status", "Resume versions (0)"]) {
      const section = screen.getByText(heading).closest("section");
      expect(section).not.toBeNull();
      expect(within(section as HTMLElement).queryAllByRole("button")).toEqual([]);
    }
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as { method?: string } | undefined;
      expect(init?.method ?? "GET").toBe("GET");
    }
  });

  it("degrades honestly when Step 2 snapshots fail but keeps the entry link", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const target = String(url);
      if (target.endsWith("/tailoring/preparation") || target.endsWith("/tailoring/workspace")) {
        return failJson();
      }
      return okJson(readyView());
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CardDrawer {...drawerProps()} />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    openResumesTab();
    expect(await screen.findByText(/step 2 status unavailable/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /start tailoring in step 1/i });
    expect(link.getAttribute("href")).toBe("/jobs/job-1/tailor?step=1");
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
});
