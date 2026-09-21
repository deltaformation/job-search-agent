"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type StepNumber = 1 | 2 | 3 | 4;

interface StepIndicatorProps {
  currentStep: StepNumber;
  maxStepReached: StepNumber;
  onNavigateToStep: (step: StepNumber) => void;
}

const STEPS: { number: StepNumber; label: string; description: string }[] = [
  { number: 1, label: "Review data", description: "JD requirements & evidence" },
  { number: 2, label: "Tailor Resume", description: "Positioning & phrase chips" },
  { number: 3, label: "Generate", description: "Synthesis & validation" },
  { number: 4, label: "Review & approve", description: "Diff audit & decision" },
];

export default function StepIndicator({
  currentStep,
  maxStepReached,
  onNavigateToStep,
}: StepIndicatorProps) {
  return (
    <nav
      aria-label="Tailoring workflow progress"
      className="border-b border-border/60 bg-card/40 px-4 py-3 sm:px-8"
    >
      <div className="mx-auto w-full max-w-[1440px]">
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-4">
          {STEPS.map((step) => {
            const isCurrent = currentStep === step.number;
            const isCompleted =
              step.number < currentStep || (step.number < maxStepReached && !isCurrent);
            const isAvailable = step.number <= maxStepReached;

            return (
              <li key={step.number} className="relative">
                <button
                  type="button"
                  disabled={!isAvailable}
                  onClick={() => onNavigateToStep(step.number)}
                  aria-current={isCurrent ? "step" : undefined}
                  className={cn(
                    "group flex w-full items-center gap-3 rounded-lg border p-2 text-left transition-all",
                    isCurrent
                      ? "border-primary/40 bg-muted"
                      : isCompleted
                        ? "border-transparent hover:bg-muted/50 cursor-pointer"
                        : "border-transparent opacity-50 cursor-not-allowed"
                  )}
                >
                  <span
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors",
                      isCurrent
                        ? "bg-primary text-primary-foreground"
                        : isCompleted
                          ? "bg-emerald-600 text-white"
                          : "border border-border bg-muted text-muted-foreground"
                    )}
                  >
                    {isCompleted && !isCurrent ? (
                      <Check className="size-3.5" aria-hidden="true" />
                    ) : (
                      step.number
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "truncate text-xs font-semibold leading-tight",
                        isCurrent
                          ? "text-primary font-bold"
                          : isCompleted
                            ? "text-foreground"
                            : "text-muted-foreground"
                      )}
                    >
                      {step.label}
                    </p>
                    <p className="truncate text-[10px] text-muted-foreground hidden sm:block">
                      {step.description}
                    </p>
                  </div>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
}
