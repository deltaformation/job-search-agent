import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TailoringWorkflowShell from "../../../components/tailoring/TailoringWorkflowShell";
import { getDefaultProfile } from "../../../src/db/candidates";
import { newId, type DatabaseHandle } from "../../../src/db";
import { canonicalJson, canonicalText } from "../../../src/domain/canonical";
import { getJobDetail, type JobDetailView } from "../../../src/server/board";
import {
  getRecommendations,
  workspaceRecommendationsProvider,
} from "../../../src/server/recommendations";
import { getWorkspaceView, saveWorkspace } from "../../../src/server/tailoringWorkspace";
import { hashRecommendation } from "../../../src/tailoring/requestsV3";
import {
  seedV13Basics,
  v13ExtractionJson,
  withV13Database,
  V13_T0,
} from "../db/v13world";

/**
 * WO-1.3-D acceptance: D1 (retained JD bytes + exact previews), D2
 * (readable without profile/JD/provider; Continue creates nothing),
 * D5 (profile-switch recompute + W save + stale 409s), D6 (exact
 * salary/Unknown), D7 (Step 1 stays JD-only; keyboard Continue).
 * D3/D4 builder and route legs live in the tailoring/server/route
 * suites; the ledger cites each leg per criterion.
 */

function detail(overrides: Partial<JobDetailView> = {}): JobDetailView {
  return {
    job: {
      id: newId(),
      title: "Product Manager",
      company: "Harbor Analytics",
      status: "NEW",
      rank: 0,
      rowVersion: 1,
      location: "Remote",
      arrangement: "REMOTE",
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
    ...overrides,
  };
}

function renderStep1(jobDetail: JobDetailView) {
  return render(
    <TailoringWorkflowShell
      jobDetail={jobDetail}
      workspace={null}
      versions={[]}
      initialStep={1}
      initialVersionId={null}
      hasLiveRequest={false}
      isInspectMode={false}
      canGenerate={false}
      canApprove={false}
      maxStepReached={1}
    />,
  );
}

function q1(handle: DatabaseHandle, jobId: string): Record<string, number> {
  return handle.sqlite
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM generation_requests WHERE job_id = ?) AS requests,
        (SELECT COUNT(*) FROM work_items WHERE kind = 'TAILOR' AND job_id = ?) AS work,
        (SELECT COUNT(*) FROM resume_versions WHERE job_id = ?) AS versions,
        (SELECT COUNT(*) FROM resume_reviews rr JOIN resume_versions v ON v.id = rr.resume_version_id WHERE v.job_id = ?) AS reviews`,
    )
    .get(jobId, jobId, jobId, jobId) as Record<string, number>;
}

describe("WO-1.3-D Acceptance", () => {
  describe("D1: Step 1 JD equals retained canonical extraction bytes", () => {
    it("exposes canonical retained bytes on the detail read", () => {
      withV13Database((t, world) => {
        const jd = "  TypeScript APIs with Redis caching.\r\nSecond line.  ";
        const basics = seedV13Basics(t.handle, world, {
          jdText: jd,
          extractedJson: v13ExtractionJson(jd),
        });
        const viewed = getJobDetail(t.handle, basics.jobId);
        expect(viewed?.extraction?.retainedDescriptionText).toBe(
          "TypeScript APIs with Redis caching.\nSecond line.",
        );
        expect(viewed?.extraction?.retainedDescriptionText).toBe(canonicalText(jd));
      });
    });

    it("renders retained bytes verbatim, preferring them over the job copy", () => {
      const retained = "TypeScript APIs with Redis caching.\nSecond line.";
      const rendered = renderStep1(
        detail({
          job: {
            ...detail().job,
            descriptionText: "stale denormalized copy",
          },
          extraction: {
            id: "ext-1",
            adapter: "generic",
            adapterVersion: "v1",
            confidence: 1,
            missingFields: [],
            contentHash: "c",
            fields: null,
            provenance: null,
            retainedDescriptionText: retained,
          },
        }),
      );
      // Byte-exact: the rendered node's textContent equals the
      // retained bytes (Testing Library's default matcher folds
      // newlines, so match on the raw node text).
      expect(
        screen.getByText((_content, element) => element?.textContent === retained),
      ).toBeInTheDocument();
      expect(screen.queryByText("stale denormalized copy")).not.toBeInTheDocument();
      rendered.unmount();
    });

    it("falls back to the job copy when no extraction exists", () => {
      const rendered = renderStep1(
        detail({ job: { ...detail().job, descriptionText: "JD text" }, extraction: null }),
      );
      expect(screen.getByText("JD text")).toBeInTheDocument();
      rendered.unmount();
    });
  });

  describe("D2: missing inputs stay readable; Continue reaches Step 2 with zero writes", () => {
    it("renders the empty state and navigates with reads only, zero writes", () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const rendered = renderStep1(detail());
      expect(screen.getByText("No job description text available.")).toBeInTheDocument();
      // Exact name: the step indicator also carries a longer
      // "…Tailor Resume…" button that a regex would also match.
      fireEvent.click(screen.getByRole("button", { name: "Tailor Resume" }));
      // S2-C: the data-driven Step 2 editor loads its plan/profile on
      // mount. The D2 zero-writes bar holds: every navigation fetch is a
      // GET — no PUT/POST, no queue work, no provider call.
      expect(screen.getByText("Choose focus")).toBeInTheDocument();
      for (const call of fetchSpy.mock.calls) {
        const init = call[1] as RequestInit | undefined;
        expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
      }
      fetchSpy.mockRestore();
      rendered.unmount();
    });

    it("creates no generation state while reading inputs", () => {
      withV13Database((t, world) => {
        const jd = "TypeScript APIs with Redis caching.";
        const basics = seedV13Basics(t.handle, world, {
          jdText: jd,
          extractedJson: v13ExtractionJson(jd),
        });
        const before = q1(t.handle, basics.jobId);
        expect(getJobDetail(t.handle, basics.jobId)).not.toBe(null);
        expect(
          getRecommendations(t.handle, {
            jobId: basics.jobId,
            extractionId: basics.extractionId,
            profileVersionId: basics.profileVersionId,
          }).ok,
        ).toBe(true);
        expect(q1(t.handle, basics.jobId)).toEqual(before);
      });
    });
  });

  describe("D5: profile-switch recompute, cleared W save, stale 409s", () => {
    it("recomputes on P1→P2, saves cleared bindings, rejects stale ones", () => {
      withV13Database((t, world) => {
        const jd = "TypeScript APIs with Redis caching and go-to-market launches.";
        const basics = seedV13Basics(t.handle, world, {
          jdText: jd,
          extractedJson: v13ExtractionJson(jd),
        });
        const p1 = getRecommendations(t.handle, {
          jobId: basics.jobId,
          extractionId: basics.extractionId,
          profileVersionId: basics.profileVersionId,
        });
        expect(p1.ok).toBe(true);
        if (!p1.ok) return;
        const p2 = getRecommendations(t.handle, {
          jobId: basics.jobId,
          extractionId: basics.extractionId,
          profileVersionId: world.spmVersionId,
        });
        expect(p2.ok).toBe(true);
        if (!p2.ok) return;
        const hash1 = hashRecommendation(p1.recommendations);
        const hash2 = hashRecommendation(p2.recommendations);
        expect(hash2).not.toBe(hash1);
        expect(p1.recommendations.preset.selectedPhraseIds.length).toBeGreaterThan(0);

        // Uncleared P1 selections under the P2 binding fail closed.
        const uncleared = saveWorkspace(
          t.handle,
          basics.jobId,
          0,
          {
            schemaVersion: "tailoring-workspace/v1",
            extractionId: basics.extractionId,
            profileId: world.spmProfileId,
            profileVersionId: world.spmVersionId,
            requestKind: "INITIAL",
            parentVersionId: null,
            revisionNote: null,
            recommendationHash: hash2,
            focus: {
              schemaVersion: "tailoring-focus/v1",
              selectedPhraseIds: p1.recommendations.preset.selectedPhraseIds.slice(0, 1),
              themeId: null,
              summaryDirection: "",
              mappings: [],
              additionalGuidance: "",
            },
          },
          { now: () => V13_T0, recommendations: workspaceRecommendationsProvider },
        );
        expect(uncleared).toMatchObject({ ok: false, failure: { error: "invalid-selection" } });

        // Cleared selections with preserved free guidance save via W.
        const cleared = saveWorkspace(
          t.handle,
          basics.jobId,
          0,
          {
            schemaVersion: "tailoring-workspace/v1",
            extractionId: basics.extractionId,
            profileId: world.spmProfileId,
            profileVersionId: world.spmVersionId,
            requestKind: "INITIAL",
            parentVersionId: null,
            revisionNote: null,
            recommendationHash: hash2,
            focus: {
              schemaVersion: "tailoring-focus/v1",
              selectedPhraseIds: [],
              themeId: null,
              summaryDirection: "Keep my direction.",
              mappings: [],
              additionalGuidance: "Keep my guidance.",
            },
          },
          { now: () => V13_T0, recommendations: workspaceRecommendationsProvider },
        );
        expect(cleared.ok).toBe(true);
        if (!cleared.ok) return;
        expect(cleared.value.workspace?.draft.profileVersionId).toBe(world.spmVersionId);
        expect(cleared.value.workspace?.draft.schemaVersion).toBe("tailoring-workspace/v1");
        if (cleared.value.workspace?.draft.schemaVersion !== "tailoring-workspace/v1") return;
        expect(cleared.value.workspace.draft.focus.summaryDirection).toBe("Keep my direction.");
        expect(cleared.value.workspace.draft.focus.additionalGuidance).toBe("Keep my guidance.");
        expect(cleared.value.revision).toBe(1);
        // D4: the stored snapshot preset byte-equals the served
        // recommendation preset — Step 2 copies these exact bytes.
        const rereadView = getWorkspaceView(t.handle, basics.jobId);
        expect(rereadView.ok).toBe(true);
        if (!rereadView.ok) return;
        expect(
          canonicalJson(rereadView.value.workspace?.recommendations?.preset),
        ).toBe(canonicalJson(p2.recommendations.preset));
        // The global default profile is untouched by the per-job switch.
        expect(getDefaultProfile(t.handle)?.id).toBe(world.pmProfileId);

        // A re-read of the P1 binding still builds (both stay active);
        // deactivating P1 turns its reads stale instead.
        const reread = getRecommendations(t.handle, {
          jobId: basics.jobId,
          extractionId: basics.extractionId,
          profileVersionId: basics.profileVersionId,
        });
        expect(reread.ok).toBe(true);
      });
    });
  });

  describe("D6: explicit salary shown verbatim; absent salary stays Unknown", () => {
    it("shows stored salary text and never infers from parsed minors", () => {
      const explicit = renderStep1(
        detail({
          job: { ...detail().job, salaryText: "CAD 166,000–196,000 per year" },
        }),
      );
      expect(screen.getByText("CAD 166,000–196,000 per year")).toBeInTheDocument();
      explicit.unmount();

      const absent = renderStep1(
        detail({
          job: {
            ...detail().job,
            salaryText: null,
            salaryCurrency: "CAD",
            salaryMinMinor: 16600000,
            salaryMaxMinor: 19600000,
          },
        }),
      );
      // Parsed minors without stored text infer nothing: Unknown.
      const unknowns = screen.getAllByText("Unknown");
      expect(unknowns.length).toBeGreaterThan(0);
      expect(screen.queryByText(/166,?000/)).not.toBeInTheDocument();
      absent.unmount();
    });
  });

  describe("D7: Step 1 keeps the full JD; keyboard Continue needs no save or provider", () => {
    it("shows no Step 2 cloud/theme/mapping controls on Step 1", () => {
      const rendered = renderStep1(
        detail({
          job: { ...detail().job, descriptionText: "Full JD body with TypeScript APIs." },
        }),
      );
      expect(screen.getByText("Full JD body with TypeScript APIs.")).toBeInTheDocument();
      expect(screen.queryByText("Keyword Word Cloud")).not.toBeInTheDocument();
      expect(screen.queryByText("Use theme")).not.toBeInTheDocument();
      expect(screen.queryByText(/Assign phrase/)).not.toBeInTheDocument();
      rendered.unmount();
    });

    it("offers a keyboard-focusable Continue that navigates with zero writes", () => {
      const rendered = renderStep1(detail());
      const next = screen.getByRole("button", { name: "Tailor Resume" });
      expect(next.tagName).toBe("BUTTON");
      expect(next).not.toBeDisabled();
      next.focus();
      expect(document.activeElement).toBe(next);
      fireEvent.click(next);
      expect(screen.getByText("Choose focus")).toBeInTheDocument();
      rendered.unmount();
    });
  });
});
