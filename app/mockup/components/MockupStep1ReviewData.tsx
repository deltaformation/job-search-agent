"use client";

import { ArrowRight, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { JobFixture } from "../fixtures/jobDescription";
import type { MasterResumeFixture } from "../fixtures/masterResume";

interface MockupStep1ReviewDataProps {
  job: JobFixture;
  master?: MasterResumeFixture;
  onContinue: () => void;
  onOpenMasterViewer?: () => void;
  onOpenJobViewer?: () => void;
}

export default function MockupStep1ReviewData({
  job,
  onContinue,
}: MockupStep1ReviewDataProps) {
  return (
    <div className="w-full space-y-8">
      {/* 1. Scraped Job Description Highlight */}
      <section
        aria-labelledby="scraped-jd-heading"
        className="rounded-xl border border-border/50 bg-card p-5 sm:p-6"
      >
        <div className="flex flex-col justify-between gap-4 border-b border-border/40 pb-4 md:flex-row md:items-center">
          <div>
            <h2 id="scraped-jd-heading" className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              {job.title}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground sm:text-sm">
              <span className="font-semibold text-foreground">{job.company}</span>
              <span>·</span>
              <span>{job.location} ({job.arrangement})</span>
              <span>·</span>
              <span className="font-mono font-medium text-foreground">{job.salaryText}</span>
              <span>·</span>
              <span>{job.employmentType}</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              asChild
              className="gap-1.5 text-xs"
            >
              <a href={job.applyUrl} target="_blank" rel="noopener noreferrer">
                <span>Original posting</span>
                <ExternalLink className="size-3" />
              </a>
            </Button>
          </div>
        </div>

        {/* Full JD Formatted Content */}
        <div className="pt-5 space-y-6 text-sm">
          {/* Company */}
          <section className="space-y-1.5">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">
              Company
            </h3>
            <p className="text-xs leading-relaxed text-foreground sm:text-sm">
              {job.sections.overview}
            </p>
          </section>

          {/* What You'll Do */}
          <section className="space-y-2">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">
              What You&apos;ll Do ({job.sections.whatYoullDo.length} items)
            </h3>
            <ul className="rounded-lg border border-border/50 bg-muted/20 p-4 space-y-2.5 text-xs leading-relaxed text-foreground">
              {job.sections.whatYoullDo.map((item, idx) => (
                <li key={idx} className="flex items-start gap-2.5">
                  <span className="text-primary font-semibold">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* About You */}
          <section className="space-y-2">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">
              About You ({job.sections.aboutYou.length} items)
            </h3>
            <ul className="rounded-lg border border-border/50 bg-muted/20 p-4 space-y-2.5 text-xs leading-relaxed text-foreground">
              {job.sections.aboutYou.map((item, idx) => (
                <li key={idx} className="flex items-start gap-2.5">
                  <span className="text-primary font-semibold">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* Compensation & Terms */}
          <section className="space-y-1.5">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">
              Compensation & Terms
            </h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {job.compensationOriginalText}
            </p>
          </section>

          {/* Ashby Link */}
          <div className="border-t border-border/40 pt-3">
            <a
              href={job.applyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              <span>View original posting on Ashby</span>
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          </div>
        </div>
      </section>

      {/* Bottom Sticky-friendly Continue Action Strip */}
      <div className="flex items-center justify-end rounded-xl border border-border/70 bg-card p-4">
        <Button
          type="button"
          onClick={onContinue}
          className="gap-2 cursor-pointer"
        >
          <span>Tailor Resume</span>
          <ArrowRight className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
