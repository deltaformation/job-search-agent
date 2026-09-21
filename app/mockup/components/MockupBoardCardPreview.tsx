"use client";

import { CheckCircle2, Download, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { JobFixture } from "../fixtures/jobDescription";

interface MockupBoardCardPreviewProps {
  job: JobFixture;
  approvedVersionLabel: string;
  pdfUrl?: string;
}

export default function MockupBoardCardPreview({
  job,
  approvedVersionLabel,
  pdfUrl = "/mockup/sample-tailored-resume.pdf",
}: MockupBoardCardPreviewProps) {
  return (
    <section className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-4  sm:p-5">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex size-5 items-center justify-center rounded-full bg-emerald-600 text-white">
              <CheckCircle2 className="size-3.5" aria-hidden="true" />
            </span>
            <span className="text-xs font-semibold tracking-wide text-emerald-700 dark:text-emerald-400">
              Primary resume selected
            </span>
            <Badge className="bg-emerald-600 text-white text-[10px]">
              {approvedVersionLabel} Primary
            </Badge>
          </div>

        </div>

        <div className="flex items-center gap-2">
          {/* Direct Download Button */}
          <a
            href={pdfUrl}
            download="Mouad_Atfi_Lead_Product_Manager_Lime.pdf"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow hover:bg-primary/90"
          >
            <Download className="size-3.5" aria-hidden="true" />
            <span>Download Resume (PDF)</span>
          </a>

          {/* Open Ashby Link */}
          <a
            href={job.applyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-card px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/40"
          >
            <span>Open application</span>
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        </div>
      </div>

      {/* Simulated Mini Kanban Card */}
      <div className="mt-4 max-w-sm rounded-xl border border-border/80 bg-card p-3.5 ">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {job.company}
          </p>
          <span className="text-[10px] text-muted-foreground">Tailored</span>
        </div>
        <h4 className="mt-1 line-clamp-2 text-sm font-semibold leading-5 text-foreground">
          {job.title}
        </h4>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="rounded-md bg-primary/10 px-2 py-0.5 font-mono text-xs font-semibold tabular-nums text-primary">
            {job.salaryText}
          </span>
          <span className="rounded-md border border-border/70 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            Remote
          </span>
          <span className="text-[11px] text-muted-foreground">Canada</span>
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-border/40 pt-2.5 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
            <span className="font-medium text-emerald-700 dark:text-emerald-400">
              {approvedVersionLabel} · Approved
            </span>
          </div>
          <span className="text-[10px] font-mono text-muted-foreground">Sample</span>
        </div>
      </div>
    </section>
  );
}
