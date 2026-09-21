"use client";

import { useCallback, useState } from "react";
import MockupHeader from "./components/MockupHeader";
import MockupNotesModal, {
  type MockupNote,
  type TimelineEvent,
} from "./components/MockupNotesModal";
import MockupPropertiesSheet from "./components/MockupPropertiesSheet";
import MockupStep1ReviewData from "./components/MockupStep1ReviewData";
import MockupStep2ChooseFocus, {
  DEFAULT_FOCUS_STATE,
  type TailoringFocusState,
} from "./components/MockupStep2ChooseFocus";
import MockupStep3SimulatedGeneration, {
  type SimulationState,
} from "./components/MockupStep3SimulatedGeneration";
import MockupStep4ReviewApprove from "./components/MockupStep4ReviewApprove";
import MockupStepIndicator, {
  type StepNumber,
} from "./components/MockupStepIndicator";
import { MockupJobViewer, MockupMasterViewer } from "./components/MockupViewers";
import { LIME_JOB_FIXTURE } from "./fixtures/jobDescription";
import { MASTER_RESUME_FIXTURE } from "./fixtures/masterResume";
import {
  TAILORED_RESUME_V1_FIXTURE,
  TAILORED_RESUME_V2_FIXTURE,
  type TailoredResumeFixture,
} from "./fixtures/tailoredResume";

export default function MockupPage() {
  // Navigation & Step State
  const [currentStep, setCurrentStep] = useState<StepNumber>(1);
  const [maxStepReached, setMaxStepReached] = useState<StepNumber>(1);

  // Application Pipeline Status
  const [pipelineStatus, setPipelineStatus] = useState<"NEW" | "TAILORED" | "APPLIED" | "REJECTED">("NEW");

  // Step 2 Focus Customization State (preserved on Back/Forward)
  const [focusState, setFocusState] = useState<TailoringFocusState>(DEFAULT_FOCUS_STATE);

  // Versions History State
  const [versions, setVersions] = useState<TailoredResumeFixture[]>([
    { ...TAILORED_RESUME_V1_FIXTURE },
  ]);
  const [activeVersionIndex, setActiveVersionIndex] = useState<number>(0);
  const [primaryApprovedVersionIndex, setPrimaryApprovedVersionIndex] = useState<number | null>(null);

  // Hoisted Simulation State (survives tab/sheet toggles)
  const [simulation, setSimulation] = useState<SimulationState>(() => ({
    status: "running",
    stageIndex: 0,
    startedAt: Date.now(),
    errorType: null,
    speed: "normal",
  }));

  // Notes & Timeline Local State
  const [notes, setNotes] = useState<MockupNote[]>([
    {
      id: "note-1",
      author: "System (Intake)",
      text: "Job extracted from Ashby URL. Verified CA$126,000–CA$174,000 salary and remote Canada residency requirement.",
      createdAt: "2026-09-15 13:00 UTC",
    },
  ]);

  const [timeline, setTimeline] = useState<TimelineEvent[]>([
    {
      id: "tl-1",
      title: "Job Clipped & Intake Verified",
      detail: "Ashby posting successfully parsed via JSON-LD adapter (schema v1).",
      timestamp: "2026-09-15 13:00 UTC",
    },
  ]);

  // Modal / Sheet Visibility State
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [masterViewerOpen, setMasterViewerOpen] = useState(false);
  const [jobViewerOpen, setJobViewerOpen] = useState(false);

  // Helper to add timeline entry
  const appendTimeline = useCallback((title: string, detail: string) => {
    const timeStr = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
    setTimeline((prev) => [
      {
        id: `tl-${Date.now()}`,
        title,
        detail,
        timestamp: timeStr,
      },
      ...prev,
    ]);
  }, []);

  // Step 1 -> Step 2
  const handleContinueToFocus = () => {
    setCurrentStep(2);
    setMaxStepReached((prev) => (prev < 2 ? 2 : prev));
  };

  // Step 2 -> Step 3 (Start Generation)
  const handleStartGeneration = () => {
    // Determine if this is initial v1 or generating v2 after revision
    const isV2Generation = versions.length === 1 && versions[0]?.reviewState !== "AWAITING_REVIEW";

    if (isV2Generation) {
      // Append v2 fixture
      setVersions((prev) => [...prev, { ...TAILORED_RESUME_V2_FIXTURE }]);
      setActiveVersionIndex(1);
    }

    setSimulation({
      status: "running",
      stageIndex: 0,
      startedAt: Date.now(),
      errorType: null,
      speed: "normal",
    });

    setCurrentStep(3);
    setMaxStepReached((prev) => (prev < 3 ? 3 : prev));

    appendTimeline(
      isV2Generation ? "Simulating Generation: Version 2" : "Simulating Generation: Version 1",
      `Initiated with focus: "${focusState.positioningTheme}".`
    );
  };

  // Step 3 -> Step 4 (Simulation Finished)
  const handleSimulationComplete = () => {
    setCurrentStep(4);
    setMaxStepReached(4);
    appendTimeline(
      "Draft Generation Completed",
      "Truthful claims compiled and side-by-side audit view prepared."
    );
  };

  // Step 4 Actions
  const handleApprove = () => {
    setVersions((prev) => {
      const copy = [...prev];
      if (copy[activeVersionIndex]) {
        copy[activeVersionIndex] = {
          ...copy[activeVersionIndex]!,
          reviewState: "APPROVED",
        };
      }
      return copy;
    });

    setPrimaryApprovedVersionIndex(activeVersionIndex);
    setPipelineStatus("TAILORED");

    const currentVer = versions[activeVersionIndex];
    appendTimeline(
      `Approved ${currentVer?.versionLabel ?? "Version"}`,
      "Job moved to Tailored status on Kanban board. Primary resume set."
    );
  };

  const handleRequestChanges = (revisionNote: string) => {
    // Record note
    setNotes((prev) => [
      {
        id: `note-${Date.now()}`,
        author: "User (Revision Request)",
        text: revisionNote,
        createdAt: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
      },
      ...prev,
    ]);

    appendTimeline(
      "Requested Changes",
      `Revision note recorded: "${revisionNote}". Returning to focus selection.`
    );

    // Navigate back to Step 2 with prior settings preserved
    setCurrentStep(2);
  };

  const handleDecline = (reason: string) => {
    setVersions((prev) => {
      const copy = [...prev];
      if (copy[activeVersionIndex]) {
        copy[activeVersionIndex] = {
          ...copy[activeVersionIndex]!,
          reviewState: "DECLINED",
        };
      }
      return copy;
    });

    setNotes((prev) => [
      {
        id: `note-${Date.now()}`,
        author: "User (Decline Decision)",
        text: `Declined reason: ${reason}`,
        createdAt: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
      },
      ...prev,
    ]);

    appendTimeline(
      `Declined ${versions[activeVersionIndex]?.versionLabel ?? "Version"}`,
      `Reason: "${reason}".`
    );
  };

  const handleAddNote = (text: string) => {
    setNotes((prev) => [
      {
        id: `note-${Date.now()}`,
        author: "User",
        text,
        createdAt: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
      },
      ...prev,
    ]);
  };

  const handleResetPrototype = () => {
    setCurrentStep(1);
    setMaxStepReached(1);
    setPipelineStatus("NEW");
    setFocusState(DEFAULT_FOCUS_STATE);
    setVersions([{ ...TAILORED_RESUME_V1_FIXTURE }]);
    setActiveVersionIndex(0);
    setPrimaryApprovedVersionIndex(null);
    setSimulation({
      status: "running",
      stageIndex: 0,
      startedAt: Date.now(),
      errorType: null,
      speed: "normal",
    });
  };

  const activeTailoredResume = versions[activeVersionIndex] || versions[0]!;

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* 1. Mockup Top Header */}
      <MockupHeader
        jobTitle={LIME_JOB_FIXTURE.title}
        company={LIME_JOB_FIXTURE.company}
        pipelineStatus={pipelineStatus}
        activeVersionLabel={
          primaryApprovedVersionIndex !== null
            ? `v${versions[primaryApprovedVersionIndex]?.version} Approved`
            : undefined
        }
        onOpenProperties={() => setPropertiesOpen(true)}
      />

      {/* 2. Numbered 4-Step Indicator */}
      <MockupStepIndicator
        currentStep={currentStep}
        maxStepReached={maxStepReached}
        onNavigateToStep={(s) => setCurrentStep(s)}
      />

      {/* 3. Main Stage Content */}
      <main id="mockup-content" className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-8 sm:px-8">
        {currentStep === 1 && (
          <MockupStep1ReviewData
            job={LIME_JOB_FIXTURE}
            master={MASTER_RESUME_FIXTURE}
            onContinue={handleContinueToFocus}
            onOpenMasterViewer={() => setMasterViewerOpen(true)}
            onOpenJobViewer={() => setJobViewerOpen(true)}
          />
        )}

        {currentStep === 2 && (
          <MockupStep2ChooseFocus
            state={focusState}
            onChange={setFocusState}
            onBack={() => setCurrentStep(1)}
            onGenerate={handleStartGeneration}
            onPreviewMaster={() => setMasterViewerOpen(true)}
          />
        )}

        {currentStep === 3 && (
          <MockupStep3SimulatedGeneration
            simulation={simulation}
            onSimulationUpdate={setSimulation}
            onComplete={handleSimulationComplete}
            onBackToFocus={() => setCurrentStep(2)}
            onReset={handleResetPrototype}
          />
        )}

        {currentStep === 4 && (
          <MockupStep4ReviewApprove
            job={LIME_JOB_FIXTURE}
            master={MASTER_RESUME_FIXTURE}
            activeTailoredResume={activeTailoredResume}
            allVersions={versions}
            activeVersionIndex={activeVersionIndex}
            primaryVersionIndex={primaryApprovedVersionIndex}
            onSelectVersion={setActiveVersionIndex}
            onApprove={handleApprove}
            onRequestChanges={handleRequestChanges}
            onDecline={handleDecline}
          />
        )}
      </main>

      {/* Slide-Over Properties Sheet */}
      <MockupPropertiesSheet
        open={propertiesOpen}
        onClose={() => setPropertiesOpen(false)}
        job={LIME_JOB_FIXTURE}
        pipelineStatus={pipelineStatus}
        approvedVersionLabel={
          primaryApprovedVersionIndex !== null
            ? `Version ${versions[primaryApprovedVersionIndex]?.version}`
            : null
        }
      />

      {/* Notes & Timeline Modal */}
      <MockupNotesModal
        open={notesOpen}
        onOpenChange={setNotesOpen}
        notes={notes}
        timeline={timeline}
        onAddNote={handleAddNote}
      />

      {/* Readable Document Viewer Modals */}
      <MockupMasterViewer
        open={masterViewerOpen}
        onOpenChange={setMasterViewerOpen}
        master={MASTER_RESUME_FIXTURE}
      />

      <MockupJobViewer
        open={jobViewerOpen}
        onOpenChange={setJobViewerOpen}
        job={LIME_JOB_FIXTURE}
      />
    </div>
  );
}
