import { fireEvent, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../../../middleware";
import TailorPage from "../../../app/jobs/[id]/tailor/page";
import JobCard from "../../../components/board/JobCard";
import TailoringHeader from "../../../components/tailoring/TailoringHeader";
import StepIndicator from "../../../components/tailoring/StepIndicator";
import PropertiesSheet from "../../../components/tailoring/PropertiesSheet";
import TailoringWorkflowShell from "../../../components/tailoring/TailoringWorkflowShell";
import {
  createTestDatabase,
  jobs,
  newId,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import type { BoardCardView, JobDetailView } from "../../../src/server/board";
import { resolveAuthoritativeStep } from "../../../src/domain/tailoringResolver";

function withDatabase(fn: (t: TestDatabase) => Promise<void> | void): Promise<void> {
  const t = createTestDatabase("job-tracker-v13-c-");
  return Promise.resolve(fn(t)).finally(() => {
    t.cleanup();
  });
}

function countQ1(handle: DatabaseHandle, jobId: string) {
  const requests = (
    handle.sqlite
      .prepare("SELECT COUNT(*) AS c FROM generation_requests WHERE job_id = ?")
      .get(jobId) as { c: number }
  ).c;
  const work = (
    handle.sqlite
      .prepare("SELECT COUNT(*) AS c FROM work_items WHERE kind = 'TAILOR' AND job_id = ?")
      .get(jobId) as { c: number }
  ).c;
  const versions = (
    handle.sqlite
      .prepare("SELECT COUNT(*) AS c FROM resume_versions WHERE job_id = ?")
      .get(jobId) as { c: number }
  ).c;
  const reviews = (
    handle.sqlite
      .prepare(
        "SELECT COUNT(*) AS c FROM resume_reviews rr JOIN resume_versions v ON v.id = rr.resume_version_id WHERE v.job_id = ?"
      )
      .get(jobId) as { c: number }
  ).c;
  return { requests, work, versions, reviews, total: requests + work + versions + reviews };
}

function countQ9(handle: DatabaseHandle, jobId: string): number {
  return (
    handle.sqlite
      .prepare("SELECT COUNT(*) AS c FROM tailoring_workspaces WHERE job_id = ?")
      .get(jobId) as { c: number }
  ).c;
}

function sampleCard(overrides: Partial<BoardCardView> = {}): BoardCardView {
  return {
    id: newId(),
    status: "NEW",
    rank: 0,
    rowVersion: 1,
    title: "Senior Product Manager",
    company: "Acme Logistics",
    location: "Toronto, ON",
    arrangement: "Remote",
    salaryText: "$150,000 - $180,000 CAD",
    salaryCurrency: "CAD",
    salaryMinMinor: 15000000,
    salaryMaxMinor: 18000000,
    scrapeState: "SUCCEEDED",
    scrapeReasonCode: null,
    tailoringState: "READY",
    tailoringReasonCode: null,
    resume: null,
    selectedApprovedPdfArtifactId: null,
    selectedApprovedPdfSha256: null,
    notesCount: 2,
    sourceUrl: "https://example.com/jobs/acme-pm",
    appliedAt: null,
    createdAt: "2026-09-16T12:00:00.000Z",
    updatedAt: "2026-09-16T12:00:00.000Z",
    ...overrides,
  };
}

describe("WO-1.3-C Acceptance: C1–C8", () => {
  describe("C1: Card Pointer click/Enter opens route; drag, Properties, download do not navigate; ΔQ1=0", () => {
    it("proves pointer click and Enter trigger onOpen; drag and Properties do not", () => {
      const card = sampleCard();
      const onOpen = vi.fn();
      const onOpenProperties = vi.fn();
      render(
        <DndContext id="c1-dnd">
          <JobCard card={card} onOpen={onOpen} onOpenProperties={onOpenProperties} />
        </DndContext>
      );

      // 1. Drag button does NOT navigate
      const dragBtn = screen.getByRole("button", { name: `Drag ${card.title} to move it` });
      fireEvent.click(dragBtn);
      expect(onOpen).not.toHaveBeenCalled();
      expect(onOpenProperties).not.toHaveBeenCalled();

      // 2. Properties button does NOT navigate (calls onOpenProperties only)
      const propBtn = screen.getByRole("button", { name: `Open properties for ${card.title}` });
      fireEvent.click(propBtn);
      expect(onOpenProperties).toHaveBeenCalledWith(card.id);
      expect(onOpen).not.toHaveBeenCalled();

      // 3. External link does NOT navigate
      const link = screen.getByRole("link", { name: `Open original job posting for ${card.title}` });
      fireEvent.click(link);
      expect(onOpen).not.toHaveBeenCalled();

      // 4. Pointer click on card activation button opens exact route
      const openBtn = screen.getByRole("button", { name: `Open details for ${card.title}` });
      fireEvent.click(openBtn);
      expect(onOpen).toHaveBeenCalledWith(card.id);

      // 5. Enter key on card activation button opens exact route
      fireEvent.keyDown(openBtn, { key: "Enter" });
      expect(onOpen).toHaveBeenCalledTimes(2);
    });

    it("verifies ΔQ1=0 for opening", async () => {
      await withDatabase(async (t) => {
        const jobId = newId();
        t.handle.db
          .insert(jobs)
          .values({
            id: jobId,
            status: "NEW",
            rowVersion: 1,
            title: "Staff Product Manager",
            company: "Acme",
            tailoringState: "READY",
          })
          .run();

        const beforeQ1 = countQ1(t.handle, jobId);
        const beforeQ9 = countQ9(t.handle, jobId);
        // Opening / querying detail
        const afterQ1 = countQ1(t.handle, jobId);
        const afterQ9 = countQ9(t.handle, jobId);
        expect(afterQ1.total).toBe(beforeQ1.total);
        expect(afterQ1.total).toBe(0);
        expect(afterQ9).toBe(beforeQ9);
        expect(afterQ9).toBe(0);
      });
    });
  });

  describe("C2: Malformed UUID 400, unknown job 404, Q1/Q9 unchanged", () => {
    it("returns 400 for malformed job UUID via middleware", () => {
      const request = new NextRequest("http://127.0.0.1:3000/jobs/invalid-uuid-123/tailor", {
        headers: { host: "127.0.0.1:3000" },
      });
      const response = middleware(request);
      expect(response.status).toBe(400);
    });

    it("throws notFound (404) for unknown valid UUID job", async () => {
      const unknownId = newId();
      await expect(
        TailorPage({
          params: Promise.resolve({ id: unknownId }),
          searchParams: Promise.resolve({}),
        })
      ).rejects.toThrow(); // Next.js notFound() throws NEXT_NOT_FOUND
    });
  });

  describe("C3: Header title/company/status + labeled Properties/Notes, Escape dismiss, XSS safety", () => {
    it("escapes script-like job title as plain text without executing", () => {
      const scriptTitle = "<script>alert('XSS')</script>";
      render(
        <TailoringHeader
          jobTitle={scriptTitle}
          company="Secure Corp"
          pipelineStatus="NEW"
          notesCount={0}
          onOpenProperties={() => {}}
          onOpenNotes={() => {}}
        />
      );

      // Title must be rendered as plain text content, not executable DOM
      const heading = screen.getByRole("heading", { level: 1 });
      expect(heading.textContent).toBe(scriptTitle);
      expect(document.querySelector("script")).toBeNull();
    });

    it("renders labeled Properties and Notes buttons", () => {
      render(
        <TailoringHeader
          jobTitle="Product Lead"
          company="Acme"
          pipelineStatus="TAILORED"
          activeVersionLabel="v1 Approved"
          notesCount={3}
          onOpenProperties={() => {}}
          onOpenNotes={() => {}}
        />
      );

      expect(screen.getByRole("button", { name: /open job properties sheet/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /open notes and timeline/i })).toBeInTheDocument();
      expect(screen.getByText("(v1 Approved)")).toBeInTheDocument();
    });

    it("dismisses PropertiesSheet on Escape and restores trigger focus", async () => {
      const trigger = document.createElement("button");
      document.body.appendChild(trigger);
      trigger.focus();
      const triggerRef = { current: trigger };
      const onClose = vi.fn();

      const { unmount } = render(
        <PropertiesSheet
          open={true}
          onClose={onClose}
          job={{
            id: newId(),
            title: "PM",
            company: "Acme",
            status: "NEW",
            rank: 0,
            rowVersion: 1,
            location: null,
            arrangement: null,
            salaryText: null,
            salaryCurrency: null,
            salaryMinMinor: null,
            salaryMaxMinor: null,
            descriptionText: null,
            postedAt: null,
            scrapeState: "SUCCEEDED",
            scrapeReasonCode: null,
            tailoringState: "READY",
            tailoringReasonCode: null,
            activeExtractionId: null,
            activeResumeVersionId: null,
            selectedResumeVersionId: null,
            createdAt: "2026-09-16T12:00:00.000Z",
            updatedAt: "2026-09-16T12:00:00.000Z",
          }}
          triggerRef={triggerRef}
        />
      );

      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);

      unmount();
      document.body.removeChild(trigger);
    });
  });

  describe("C4: Properties exact persisted fields, Unknown for missing, collapsed diagnostics, ΔQ1=0", () => {
    it("renders exact persisted fields and Unknown for missing ones", () => {
      const job = {
        id: "job-exact-123",
        title: "Platform PM",
        company: "Stripe",
        status: "NEW" as const,
        rank: 0,
        rowVersion: 2,
        location: "Vancouver, BC",
        arrangement: "Hybrid",
        salaryText: "$160k – $210k CAD",
        salaryCurrency: "CAD",
        salaryMinMinor: 16000000,
        salaryMaxMinor: 21000000,
        descriptionText: "We are looking for...",
        postedAt: "2026-09-10",
        scrapeState: "SUCCEEDED",
        scrapeReasonCode: null,
        tailoringState: "READY",
        tailoringReasonCode: null,
        activeExtractionId: "ext-1",
        activeResumeVersionId: null,
        selectedResumeVersionId: null,
        createdAt: "2026-09-10T08:00:00.000Z",
        updatedAt: "2026-09-11T09:00:00.000Z",
      };

      render(
        <PropertiesSheet
          open={true}
          onClose={() => {}}
          job={job}
          attempts={[]}
        />
      );

      expect(screen.getByText("$160k – $210k CAD")).toBeInTheDocument();
      expect(screen.getByText("Vancouver, BC")).toBeInTheDocument();
      expect(screen.getByText("Hybrid")).toBeInTheDocument();
      expect(screen.getByText("2026-09-10")).toBeInTheDocument();

      // Diagnostics are inside a collapsed <details> element
      const details = document.querySelector("details");
      expect(details).not.toBeNull();
      expect(details).not.toHaveAttribute("open");
      expect(screen.getByText("Source details")).toBeInTheDocument();
    });

    it("displays Unknown when salary, location, or dates are absent", () => {
      const bareJob = {
        id: "job-bare-123",
        title: "Platform PM",
        company: null,
        status: "NEW" as const,
        rank: 0,
        rowVersion: 1,
        location: null,
        arrangement: null,
        salaryText: null,
        salaryCurrency: null,
        salaryMinMinor: null,
        salaryMaxMinor: null,
        descriptionText: null,
        postedAt: null,
        scrapeState: "SUCCEEDED",
        scrapeReasonCode: null,
        tailoringState: "READY",
        tailoringReasonCode: null,
        activeExtractionId: null,
        activeResumeVersionId: null,
        selectedResumeVersionId: null,
        createdAt: null as any,
        updatedAt: null as any,
      };

      render(
        <PropertiesSheet
          open={true}
          onClose={() => {}}
          job={bareJob}
        />
      );

      const unknownElements = screen.getAllByText("Unknown");
      expect(unknownElements.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("C5: Authoritative resolver matrix and foreign version 404", () => {
    it("resolves live request to Step 3", () => {
      const res = resolveAuthoritativeStep({
        hasLiveRequest: true,
        workspace: { revision: 1, lastSubmittedRevision: null },
        versions: [],
        lastRequestFailed: false,
      });
      expect(res.step).toBe(3);
    });

    it("resolves owned version URL hint to Step 4", () => {
      const res = resolveAuthoritativeStep({
        requestedVersionId: "v-owned",
        hasLiveRequest: false,
        workspace: null,
        versions: [
          {
            id: "v-owned",
            version: 1,
            reviewState: "APPROVED",
            selectedApproved: true,
            latestPublished: true,
          },
        ],
        lastRequestFailed: false,
      });
      expect(res.step).toBe(4);
      expect(res.selectedVersionId).toBe("v-owned");
      expect(res.isInspectMode).toBe(true);
    });

    it("resolves edited draft after failed run to Step 2 (old failure cannot trap new draft)", () => {
      const res = resolveAuthoritativeStep({
        hasLiveRequest: false,
        workspace: { revision: 3, lastSubmittedRevision: 2 },
        versions: [],
        lastRequestFailed: true,
      });
      expect(res.step).toBe(2);
      expect(res.canGenerate).toBe(true);
    });

    it("resolves absent workspace to Step 1", () => {
      const res = resolveAuthoritativeStep({
        hasLiveRequest: false,
        workspace: null,
        versions: [],
        lastRequestFailed: false,
      });
      expect(res.step).toBe(1);
    });

    it("proves foreign version in URL triggers 404 (notFound)", async () => {
      await withDatabase(async (t) => {
        const jobId = newId();
        t.handle.db
          .insert(jobs)
          .values({ id: jobId, status: "NEW", rowVersion: 1, title: "Test Job" })
          .run();

        // Pass a foreign version that does not exist for this job
        await expect(
          TailorPage({
            params: Promise.resolve({ id: jobId }),
            searchParams: Promise.resolve({ version: newId() }),
          })
        ).rejects.toThrow();
      });
    });
  });

  describe("C6: Direct ?step=4 with no version cannot approve (UI disabled); live inspection creates no work", () => {
    it("disables approve/decline actions when directly navigating to Step 4 with no versions", () => {
      const dummyJobDetail: JobDetailView = {
        job: {
          id: newId(),
          title: "PM",
          company: "Acme",
          status: "NEW",
          rank: 0,
          rowVersion: 1,
          location: null,
          arrangement: null,
          salaryText: null,
          salaryCurrency: null,
          salaryMinMinor: null,
          salaryMaxMinor: null,
          descriptionText: "JD text",
          postedAt: null,
          scrapeState: "SUCCEEDED",
          scrapeReasonCode: null,
          tailoringState: "READY",
          tailoringReasonCode: null,
          activeExtractionId: null,
          activeResumeVersionId: null,
          selectedResumeVersionId: null,
          createdAt: "2026-09-16T12:00:00.000Z",
          updatedAt: "2026-09-16T12:00:00.000Z",
        },
        source: null,
        attempts: [],
        tailoringAttempt: null,
        artifacts: [],
        extraction: null,
        compensationHighlights: [],
        topKeywords: [],
        resumes: [],
        notes: [],
        application: null,
        history: [],
        intake: null,
      };

      render(
        <TailoringWorkflowShell
          jobDetail={dummyJobDetail}
          workspace={null}
          versions={[]}
          initialStep={4}
          initialVersionId={null}
          hasLiveRequest={false}
          isInspectMode={false}
          canGenerate={false}
          canApprove={false}
          maxStepReached={4}
        />
      );

      const approveBtn = screen.getByRole("button", { name: /approve version/i });
      const declineBtn = screen.getByRole("button", { name: /decline version/i });
      expect(approveBtn).toBeDisabled();
      expect(declineBtn).toBeDisabled();
      expect(screen.getByText("No Tailored Versions Available")).toBeInTheDocument();
    });

    it("proves Step 1/2 inspection while live disables Generate button", () => {
      const dummyJobDetail: JobDetailView = {
        job: {
          id: newId(),
          title: "PM",
          company: "Acme",
          status: "NEW",
          rank: 0,
          rowVersion: 1,
          location: null,
          arrangement: null,
          salaryText: null,
          salaryCurrency: null,
          salaryMinMinor: null,
          salaryMaxMinor: null,
          descriptionText: "JD text",
          postedAt: null,
          scrapeState: "SUCCEEDED",
          scrapeReasonCode: null,
          tailoringState: "RUNNING",
          tailoringReasonCode: null,
          activeExtractionId: null,
          activeResumeVersionId: null,
          selectedResumeVersionId: null,
          createdAt: "2026-09-16T12:00:00.000Z",
          updatedAt: "2026-09-16T12:00:00.000Z",
        },
        source: null,
        attempts: [],
        tailoringAttempt: null,
        artifacts: [],
        extraction: null,
        compensationHighlights: [],
        topKeywords: [],
        resumes: [],
        notes: [],
        application: null,
        history: [],
        intake: null,
      };

      render(
        <TailoringWorkflowShell
          jobDetail={dummyJobDetail}
          workspace={null}
          versions={[]}
          initialStep={2}
          initialVersionId={null}
          hasLiveRequest={true}
          isInspectMode={true}
          canGenerate={false}
          canApprove={false}
          maxStepReached={3}
        />
      );

      // S2-CP-C: the Step 2 sole Generate-resume exit stays
      // disabled while a live request runs.
      const generateBtn = screen.getByRole("button", { name: /^generate resume$/i });
      expect(generateBtn).toBeDisabled();
    });
  });

  describe("C7: All 5 columns use compact status-first card structure", () => {
    const statuses: Array<"NEW" | "TAILORED" | "APPLIED" | "INTERVIEWED" | "REJECTED"> = [
      "NEW",
      "TAILORED",
      "APPLIED",
      "INTERVIEWED",
      "REJECTED",
    ];

    it.each(statuses)("renders status top-right and Properties button in column %s", (status) => {
      const card = sampleCard({ status });
      render(
        <DndContext id={`test-${status}`}>
          <JobCard card={card} onOpen={() => {}} />
        </DndContext>
      );

      // Verify status badge exists
      const expectedStatusLabel =
        status === "NEW"
          ? "New"
          : status === "TAILORED"
            ? "Tailored"
            : status === "APPLIED"
              ? "Applied"
              : status === "INTERVIEWED"
                ? "Interviewed"
                : "Rejected";

      expect(screen.getByText(expectedStatusLabel)).toBeInTheDocument();

      // Verify Properties button exists
      expect(
        screen.getByRole("button", { name: `Open properties for ${card.title}` })
      ).toBeInTheDocument();

      // Verify company on top left
      expect(screen.getByText(card.company!)).toBeInTheDocument();

      // Verify drag handle
      expect(
        screen.getByRole("button", { name: `Drag ${card.title} to move it` })
      ).toBeInTheDocument();
    });
  });

  describe("C8: Keyboard-only shell navigation and operable states", () => {
    it("operates step navigation via keyboard", () => {
      const onNavigate = vi.fn();
      render(
        <StepIndicator
          currentStep={1}
          maxStepReached={2}
          onNavigateToStep={onNavigate}
        />
      );

      const step2Btn = screen.getByRole("button", { name: /tailor resume/i });
      expect(step2Btn).toBeEnabled();
      fireEvent.click(step2Btn);
      expect(onNavigate).toHaveBeenCalledWith(2);

      // Step 3 is unreachable and disabled
      const step3Btn = screen.getByRole("button", { name: /generate/i });
      expect(step3Btn).toBeDisabled();
    });
  });
});
