"use client";

import { ExternalLink, FileText, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { JobFixture } from "../fixtures/jobDescription";
import type { MasterResumeFixture } from "../fixtures/masterResume";

interface MockupMasterViewerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  master: MasterResumeFixture;
}

export function MockupMasterViewer({
  open,
  onOpenChange,
  master,
}: MockupMasterViewerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto sm:max-w-4xl">
        <DialogHeader className="border-b border-border/60 pb-3">
          <div className="flex items-center gap-2">
            <User className="size-5 text-primary" aria-hidden="true" />
            <DialogTitle className="text-xl font-semibold">Master Resume</DialogTitle>
            <Badge variant="outline" className="ml-auto text-xs font-mono">
              Master
            </Badge>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            {master.identity.fullName} · {master.identity.headline} · {master.identity.location}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 pt-2 text-sm">
          {/* Header Info */}
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3 font-mono text-xs">
            <p>
              <strong className="text-foreground">Email:</strong> {master.identity.email} ·{" "}
              <strong className="text-foreground">Phone:</strong> {master.identity.phone} ·{" "}
              <strong className="text-foreground">Location:</strong> {master.identity.location}
            </p>
          </div>

          {/* Summary */}
          <section>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">
              Master Summary
            </h3>
            <p className="mt-1.5 leading-relaxed text-foreground">{master.summary}</p>
          </section>

          {/* Experience */}
          <section className="space-y-4">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">
              Professional Experience
            </h3>
            {master.employment.map((job) => (
              <article key={job.id} className="rounded-lg border border-border/50 bg-card p-3.5">
                <div className="flex flex-wrap items-baseline justify-between gap-1">
                  <h4 className="font-semibold text-foreground">
                    {job.role} · <span className="text-primary">{job.company}</span>
                  </h4>
                  <span className="font-mono text-xs text-muted-foreground">
                    {job.startDate} – {job.isCurrent ? "Present" : job.endDate} · {job.location}
                  </span>
                </div>
                {job.description && (
                  <p className="mt-1 text-xs italic text-muted-foreground">{job.description}</p>
                )}
                <ul className="mt-2.5 list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-foreground">
                  {job.bullets.map((bullet, idx) => (
                    <li key={idx}>{bullet}</li>
                  ))}
                </ul>
              </article>
            ))}
          </section>

          {/* Skills */}
          <section>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">
              Categorized Skills
            </h3>
            <div className="mt-2 space-y-2">
              {Object.entries(master.skillsByCategory).map(([category, skills]) => (
                <div key={category} className="text-xs">
                  <span className="font-semibold text-foreground">{category}: </span>
                  <span className="text-muted-foreground">{skills.join(", ")}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Education */}
          <section>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">
              Education
            </h3>
            <div className="mt-2 space-y-1 text-xs text-foreground">
              {master.education.map((edu, idx) => (
                <p key={idx}>
                  <strong className="font-semibold">{edu.degree}</strong>, {edu.fieldOfStudy} —{" "}
                  {edu.institution} ({edu.startDate.slice(0, 4)} – {edu.endDate.slice(0, 4)})
                </p>
              ))}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface MockupJobViewerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: JobFixture;
}

export function MockupJobViewer({ open, onOpenChange, job }: MockupJobViewerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto sm:max-w-4xl">
        <DialogHeader className="border-b border-border/60 pb-3">
          <div className="flex items-center gap-2">
            <FileText className="size-5 text-primary" aria-hidden="true" />
            <DialogTitle className="text-xl font-semibold">{job.title}</DialogTitle>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            {job.company} · {job.location} ({job.arrangement}) · {job.salaryText}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 pt-2 text-sm">
          {/* Metadata Grid */}
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs sm:grid-cols-4">
            <div>
              <p className="text-muted-foreground">Location</p>
              <p className="font-medium text-foreground">{job.location} (Remote)</p>
            </div>
            <div>
              <p className="text-muted-foreground">Department</p>
              <p className="font-medium text-foreground">{job.department}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Employment</p>
              <p className="font-medium text-foreground">{job.employmentType}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Base Salary</p>
              <p className="font-mono font-medium text-foreground">{job.salaryText}</p>
            </div>
          </div>

          {/* Residence alert */}
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
            <strong>Residence:</strong> {job.residenceRequirement}.
          </div>

          {/* Full JD sections */}
          <section>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">
              Company
            </h3>
            <p className="mt-1.5 leading-relaxed text-foreground">{job.sections.overview}</p>
          </section>

          <section>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">
              What You&apos;ll Do
            </h3>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-foreground">
              {job.sections.whatYoullDo.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">
              About You
            </h3>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-foreground">
              {job.sections.aboutYou.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">
              Compensation & Terms
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {job.compensationOriginalText}
            </p>
          </section>

          {/* Ashby Link */}
          <div className="border-t border-border/50 pt-3">
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
      </DialogContent>
    </Dialog>
  );
}
