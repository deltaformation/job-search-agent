"use client";

import { useCallback, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { JobDetailView } from "@/src/server/board";
import type { WorkspaceViewV2 } from "@/src/domain/step2";
import type { WorkspaceViewV3 } from "@/src/domain/step2Correction";
import type { WorkspaceView } from "@/src/domain/tailoringWorkspace";
import type { VersionSummary } from "@/src/server/tailoringWorkspace";
import NotesModal from "./NotesModal";
import PropertiesSheet from "./PropertiesSheet";
import Step2Focus from "./Step2Focus";
import Step3Progress from "./Step3Progress";
import Step4Review from "./Step4Review";
import StepIndicator, { type StepNumber } from "./StepIndicator";
import TailoringHeader from "./TailoringHeader";

interface TailoringWorkflowShellProps {
  jobDetail: JobDetailView;
  workspace: WorkspaceView | WorkspaceViewV2 | WorkspaceViewV3 | null;
  versions: VersionSummary[];
  initialStep: StepNumber;
  initialVersionId: string | null;
  hasLiveRequest: boolean;
  liveRequestId?: string | null;
  isInspectMode: boolean;
  canGenerate: boolean;
  canApprove: boolean;
  maxStepReached: StepNumber;
}

export default function TailoringWorkflowShell({
  jobDetail: initialJobDetail,
  workspace,
  versions,
  initialStep,
  initialVersionId,
  hasLiveRequest: _hasLiveRequest,
  liveRequestId = null,
  isInspectMode: _isInspectMode,
  canGenerate: initialCanGenerate,
  canApprove: _initialCanApprove,
  maxStepReached: initialMaxStepReached,
}: TailoringWorkflowShellProps) {
  const [jobDetail, setJobDetail] = useState<JobDetailView>(initialJobDetail);
  const [currentStep, setCurrentStep] = useState<StepNumber>(initialStep);
  const [selectedVersionId] = useState<string | null>(initialVersionId);
  const [maxStepReached, setMaxStepReached] = useState<StepNumber>(initialMaxStepReached);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  const propertiesTriggerRef = useRef<HTMLButtonElement | null>(null);
  const notesTriggerRef = useRef<HTMLButtonElement | null>(null);

  // Sync step navigation to URL without mutation or page reload (C1, C2, C5)
  const handleNavigateStep = useCallback(
    (step: StepNumber) => {
      setCurrentStep(step);
      if (step > maxStepReached) {
        setMaxStepReached(step);
      }
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.set("step", String(step));
        if (step !== 4) {
          url.searchParams.delete("version");
        }
        window.history.pushState(null, "", url.toString());
      }
    },
    [maxStepReached]
  );

  const handleRefreshJob = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobDetail.job.id}`);
      if (res.ok) {
        const data = (await res.json()) as JobDetailView;
        setJobDetail(data);
      }
    } catch {
      // safe degrade
    }
  }, [jobDetail.job.id]);

  const approvedVersion = versions.find((v) => v.selectedApproved) ?? null;
  const activeVersionLabel = approvedVersion ? `v${approvedVersion.version} Approved` : null;
  // D1: Step 1 renders the retained canonical extraction bytes; the
  // denormalized job copy is the fallback when no extraction exists.
  const step1Description =
    jobDetail.extraction?.retainedDescriptionText ?? jobDetail.job.descriptionText;

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* 1. Header */}
      <TailoringHeader
        jobTitle={jobDetail.job.title ?? "Untitled posting"}
        company={jobDetail.job.company}
        pipelineStatus={jobDetail.job.status}
        activeVersionLabel={activeVersionLabel}
        notesCount={jobDetail.notes.length}
        onOpenProperties={() => setPropertiesOpen(true)}
        onOpenNotes={() => setNotesOpen(true)}
        propertiesTriggerRef={propertiesTriggerRef}
        notesTriggerRef={notesTriggerRef}
      />

      {/* 2. Step Indicator */}
      <StepIndicator
        currentStep={currentStep}
        maxStepReached={maxStepReached}
        onNavigateToStep={handleNavigateStep}
      />

      {/* 3. Main Workflow Body */}
      <main className="mx-auto flex-1 w-full max-w-[1440px] px-4 py-6 sm:px-8">
        {/* Step 1: Review Data */}
        {currentStep === 1 && (
          <section aria-labelledby="step1-heading" className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/60 pb-4">
              <div>
                <h2 id="step1-heading" className="text-xl font-bold tracking-tight">
                  Review Data
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Inspect retained job requirements and extraction evidence before tailoring.
                </p>
              </div>
              <div className="flex items-center gap-3">
                {jobDetail.source?.canonicalUrl && (
                  <a
                    href={jobDetail.source.canonicalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/40 transition-colors"
                  >
                    <span>Original posting</span>
                    <ExternalLink className="size-3 text-muted-foreground" />
                  </a>
                )}
                <Button
                  type="button"
                  onClick={() => handleNavigateStep(2)}
                  className="gap-1.5 text-xs font-semibold cursor-pointer"
                >
                  <span>Tailor Resume</span>
                  <ArrowRight className="size-3.5" />
                </Button>
              </div>
            </div>

            {/* Posting Summary Box */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4 rounded-xl border border-border/70 bg-card">
              <div>
                <span className="text-[11px] font-semibold uppercase text-muted-foreground">Title</span>
                <p className="text-xs font-semibold mt-0.5">{jobDetail.job.title ?? "Unknown"}</p>
              </div>
              <div>
                <span className="text-[11px] font-semibold uppercase text-muted-foreground">Company</span>
                <p className="text-xs font-semibold mt-0.5">{jobDetail.job.company ?? "Unknown"}</p>
              </div>
              <div>
                <span className="text-[11px] font-semibold uppercase text-muted-foreground">Location</span>
                <p className="text-xs font-semibold mt-0.5">{jobDetail.job.location ?? "Unknown"}</p>
              </div>
              <div>
                <span className="text-[11px] font-semibold uppercase text-muted-foreground">Salary</span>
                <p className="text-xs font-semibold mt-0.5 font-mono">{jobDetail.job.salaryText ?? "Unknown"}</p>
              </div>
            </div>

            {/* Canonical Job Description (D1: retained extraction bytes) */}
            <div className="rounded-xl border border-border/70 bg-card p-5 space-y-3">
              <h3 className="text-sm font-semibold tracking-tight text-foreground">
                Job Description
              </h3>
              {step1Description ? (
                <div className="whitespace-pre-wrap text-xs leading-relaxed text-foreground max-h-[600px] overflow-y-auto pr-2">
                  {step1Description}
                </div>
              ) : (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  No job description text available.
                </p>
              )}
            </div>
          </section>
        )}

        {/* Step 2: Tailor Resume (WO-1.3-E focus drafts + generation dispatch) */}
        {currentStep === 2 && (
          <Step2Focus
            jobId={jobDetail.job.id}
            activeExtractionId={jobDetail.job.activeExtractionId}
            initialJobRowVersion={jobDetail.job.rowVersion}
            initialWorkspace={workspace}
            canGenerate={initialCanGenerate}
            onNavigateStep={handleNavigateStep}
          />
        )}

        {/* Step 3: Generate (Honest status surface for WO-1.3-F) */}
        {currentStep === 3 && (
          <section aria-labelledby="step3-heading" className="space-y-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-4">
              <div>
                <h2 id="step3-heading" className="text-xl font-bold tracking-tight">
                  Generate Resume
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Execution status, worker progress, and deterministic validation.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleNavigateStep(2)}
                className="gap-1.5 text-xs font-medium cursor-pointer"
              >
                <ArrowLeft className="size-3.5" />
                <span>Back to focus</span>
              </Button>
            </div>

            <Step3Progress
              jobId={jobDetail.job.id}
              requestId={liveRequestId ?? workspace?.lastRequestId ?? null}
              onNavigateStep={handleNavigateStep}
            />
          </section>
        )}

        {/* Step 4: Review & Approve (WO-1.3-G exact-version review) */}
        {currentStep === 4 && (
          <div>
            <div className="border-b border-border/60 pb-4">
              <h2 id="step4-heading" className="text-xl font-bold tracking-tight">
                Review & Approve
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Audit tailored claims, review diffs, and make approval decisions.
              </p>
            </div>
            <div className="pt-4">
              <Step4Review
                jobId={jobDetail.job.id}
                versions={versions}
                initialVersionId={selectedVersionId}
                onNavigateStep={handleNavigateStep}
              />
            </div>
          </div>
        )}
      </main>

      {/* 4. Properties Sheet */}
      <PropertiesSheet
        open={propertiesOpen}
        onClose={() => setPropertiesOpen(false)}
        job={jobDetail.job}
        extraction={jobDetail.extraction}
        attempts={jobDetail.attempts}
        source={jobDetail.source}
        approvedVersionLabel={activeVersionLabel}
        triggerRef={propertiesTriggerRef}
      />

      {/* 5. Notes Modal */}
      <NotesModal
        open={notesOpen}
        onOpenChange={setNotesOpen}
        jobId={jobDetail.job.id}
        notes={jobDetail.notes}
        history={jobDetail.history}
        onNoteAdded={handleRefreshJob}
        triggerRef={notesTriggerRef}
      />
    </div>
  );
}
