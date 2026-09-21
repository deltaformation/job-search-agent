"use client";

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Clock,
  RefreshCw,
  Server,
  Sparkles,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import MockupConnectionDialog from "./MockupConnectionDialog";

export type SimulationStage = 0 | 1 | 2 | 3 | 4;

export const SIMULATION_STAGES: {
  index: SimulationStage;
  label: string;
  description: string;
  durationMs: number;
}[] = [
  {
    index: 0,
    label: "Checking inputs",
    description: "Checking your profile and selected focus.",
    durationMs: 2000,
  },
  {
    index: 1,
    label: "Waiting for AI response",
    description: "Waiting for the draft.",
    durationMs: 3500,
  },
  {
    index: 2,
    label: "Validating proposed claims",
    description: "Checking claims against your experience.",
    durationMs: 2500,
  },
  {
    index: 3,
    label: "Preparing documents",
    description: "Formatting your resume.",
    durationMs: 2000,
  },
  {
    index: 4,
    label: "Saving sample result",
    description: "Preparing the comparison.",
    durationMs: 1500,
  },
];

export interface SimulationState {
  status: "running" | "error" | "complete";
  stageIndex: SimulationStage;
  startedAt: number;
  errorType: "spawn_failure" | "provider_timeout" | null;
  speed: "normal" | "slow";
}

interface MockupStep3SimulatedGenerationProps {
  simulation: SimulationState;
  onSimulationUpdate: (updater: (prev: SimulationState) => SimulationState) => void;
  onComplete: () => void;
  onBackToFocus: () => void;
  onReset: () => void;
}

export default function MockupStep3SimulatedGeneration({
  simulation,
  onSimulationUpdate,
  onComplete,
  onBackToFocus,
  onReset,
}: MockupStep3SimulatedGenerationProps) {
  const [now, setNow] = useState(() => simulation.startedAt);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [errorDetailsOpen, setErrorDetailsOpen] = useState(false);
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);

  // Stable clock timer
  useEffect(() => {
    if (simulation.status !== "running") return;
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 200);
    return () => clearInterval(interval);
  }, [simulation.status]);

  // Simulation progression engine
  useEffect(() => {
    if (simulation.status !== "running") return;

    const currentStage = SIMULATION_STAGES[simulation.stageIndex];
    if (!currentStage) return;

    const multiplier = simulation.speed === "slow" && simulation.stageIndex === 1 ? 3 : 1;
    const stepDuration = currentStage.durationMs * multiplier;

    const timer = setTimeout(() => {
      if (simulation.stageIndex < 4) {
        onSimulationUpdate((prev) => ({
          ...prev,
          stageIndex: (prev.stageIndex + 1) as SimulationStage,
        }));
      } else {
        onSimulationUpdate((prev) => ({
          ...prev,
          status: "complete",
        }));
        onComplete();
      }
    }, stepDuration);

    return () => clearTimeout(timer);
  }, [
    simulation.status,
    simulation.stageIndex,
    simulation.speed,
    onSimulationUpdate,
    onComplete,
  ]);

  const elapsedMs = Math.max(0, now - simulation.startedAt);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  const currentStageInfo = SIMULATION_STAGES[simulation.stageIndex] || SIMULATION_STAGES[0];

  // Prototype control handlers
  const handleFastForward = () => {
    onSimulationUpdate((prev) => ({
      ...prev,
      stageIndex: 4,
      status: "complete",
    }));
    onComplete();
  };

  const handleSimulateSlow = () => {
    onSimulationUpdate((prev) => ({
      ...prev,
      speed: "slow",
    }));
  };

  const handleSimulateSpawnError = () => {
    onSimulationUpdate((prev) => ({
      ...prev,
      status: "error",
      errorType: "spawn_failure",
    }));
  };

  const handleSimulateTimeoutError = () => {
    onSimulationUpdate((prev) => ({
      ...prev,
      status: "error",
      errorType: "provider_timeout",
    }));
  };

  const handleRetry = () => {
    onSimulationUpdate((prev) => ({
      ...prev,
      status: "running",
      errorType: null,
      stageIndex: 0,
      startedAt: Date.now(),
    }));
    setNow(Date.now());
  };

  return (
    <div className="space-y-6">
      {/* Screen reader polite announcement on stage update */}
      <div className="sr-only" role="status" aria-live="polite">
        {simulation.status === "running"
          ? `Generation stage ${simulation.stageIndex + 1} of 5: ${currentStageInfo?.label}`
          : simulation.status === "error"
            ? `Generation error: ${simulation.errorType}`
            : "Generation complete"}
      </div>

      {/* Main Generation Status Surface */}
      <section className="rounded-xl border border-border/70 bg-card p-6  sm:p-8">
        {simulation.status === "error" ? (
          /* Error State */
          <div className="space-y-5">
            <div className="flex items-start gap-4">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400">
                <XCircle className="size-6" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <span className="text-xs font-semibold tracking-wide text-rose-600 dark:text-rose-400">
                  Generation paused
                </span>
                <h2 className="text-lg font-semibold text-foreground">
                  {simulation.errorType === "spawn_failure"
                    ? "The app couldn’t start the AI connection process."
                    : "The provider took too long to respond."}
                </h2>
                <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
                  {simulation.errorType === "spawn_failure"
                    ? "Check the connection, then retry. Your choices are saved for this session."
                    : "Try again. Your choices are saved for this session."}
                </p>
              </div>
            </div>

            {/* Error Actions */}
            <div className="flex flex-wrap items-center gap-3 border-t border-border/50 pt-4">
              <Button type="button" onClick={handleRetry} className="gap-2 font-semibold">
                <RefreshCw className="size-4" aria-hidden="true" />
                <span>Retry generation</span>
              </Button>

              {simulation.errorType === "spawn_failure" && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setConnectionDialogOpen(true)}
                  className="gap-2 text-xs"
                >
                  <Server className="size-3.5" aria-hidden="true" />
                  <span>Check connection</span>
                </Button>
              )}

              <Button
                type="button"
                variant="ghost"
                onClick={onBackToFocus}
                className="gap-2 text-xs text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" aria-hidden="true" />
                <span>Back to focus</span>
              </Button>
            </div>

            {/* Technical disclosure */}
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
              <button
                type="button"
                onClick={() => setErrorDetailsOpen(!errorDetailsOpen)}
                className="flex w-full items-center justify-between text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <span className="font-semibold">Error details</span>
                {errorDetailsOpen ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
              </button>
              {errorDetailsOpen && (
                <pre className="mt-2 overflow-x-auto rounded bg-background p-2.5 font-mono text-[11px] text-muted-foreground">
                  {simulation.errorType === "spawn_failure"
                    ? "Error: provider spawn failed: 'node'\n  code: ENOENT / EACCES\n  supervisor: 127.0.0.1:3000\n  state: process-failed-before-handshake"
                    : "Error: HTTP 504 Gateway Timeout\n  endpoint: https://openrouter.ai/api/v1/chat/completions\n  latency: 30000ms timeout threshold reached\n  attemptId: sim-attempt-984a2"}
                </pre>
              )}
            </div>
          </div>
        ) : (
          /* Running State */
          <div className="space-y-6">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <div className="flex items-center gap-3">
                <div className="relative flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Sparkles className="size-5 animate-pulse" aria-hidden="true" />
                  <span className="absolute inset-0 animate-ping rounded-full bg-primary/20 opacity-75" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold tracking-wide text-primary">
                      Preparing your resume
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      Stage {simulation.stageIndex + 1} of 5
                    </Badge>
                  </div>
                  <h2 className="text-base font-semibold text-foreground sm:text-lg">
                    {currentStageInfo?.label}
                  </h2>
                </div>
              </div>

              {/* Monospace Tabular-Nums Stable Elapsed Clock */}
              <div className="flex items-center gap-2 self-start rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 sm:self-center">
                <Clock className="size-4 text-muted-foreground" aria-hidden="true" />
                <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                  {elapsedSeconds}s elapsed
                </span>
              </div>
            </div>

            {/* Dynamic Stage Description */}
            <p className="rounded-lg border border-primary/20 bg-primary/5 p-3.5 text-xs leading-relaxed text-foreground sm:text-sm">
              {currentStageInfo?.description}
            </p>

            {/* 5-Stage Stepper Progress Tracker */}
            <div className="space-y-2">
              <div className="grid grid-cols-5 gap-1.5 sm:gap-2">
                {SIMULATION_STAGES.map((s) => {
                  const isDone = s.index < simulation.stageIndex;
                  const isCurrent = s.index === simulation.stageIndex;

                  return (
                    <div key={s.index} className="space-y-1.5">
                      <div
                        className={`h-2 rounded-full transition-all duration-300 ${
                          isDone
                            ? "bg-emerald-600"
                            : isCurrent
                              ? "bg-primary animate-pulse"
                              : "bg-muted"
                        }`}
                      />
                      <p
                        className={`truncate text-[10px] sm:text-xs ${
                          isCurrent
                            ? "font-semibold text-primary"
                            : isDone
                              ? "font-medium text-foreground"
                              : "text-muted-foreground"
                        }`}
                      >
                        {s.label}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Discreet Prototype Controls Disclosure */}
      <section className="rounded-xl border border-dashed border-border/70 bg-card/50 p-4">
        <button
          type="button"
          onClick={() => setControlsOpen(!controlsOpen)}
          className="flex w-full items-center justify-between text-xs text-muted-foreground hover:text-foreground cursor-pointer"
          aria-expanded={controlsOpen}
        >
          <div className="flex items-center gap-2">
            <span className="font-semibold text-foreground">Simulation</span>
            <span className="font-mono text-[11px]">Sample run</span>
          </div>
          {controlsOpen ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </button>

        {controlsOpen && (
          <div className="mt-3 space-y-3 border-t border-border/40 pt-3 text-xs">

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleFastForward}
                className="text-xs"
              >
                Complete now
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleSimulateSlow}
                className="text-xs"
              >
                Slow response
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleSimulateSpawnError}
                className="text-xs border-rose-500/30 text-rose-600 hover:bg-rose-500/10"
              >
                Launch failure
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleSimulateTimeoutError}
                className="text-xs border-amber-500/30 text-amber-600 hover:bg-amber-500/10"
              >
                Provider error
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onReset}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Reset
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* Mock Connection Diagnostic Dialog */}
      <MockupConnectionDialog
        open={connectionDialogOpen}
        onOpenChange={setConnectionDialogOpen}
        errorType={simulation.errorType}
        onSimulateRecovery={handleRetry}
      />
    </div>
  );
}
