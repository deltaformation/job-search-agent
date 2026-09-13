import { Badge } from "@/components/ui/badge";
import { CheckCircle2, ShieldCheck } from "lucide-react";

export default function PlatformStatus() {
  return (
    <section
      id="platform-status"
      aria-labelledby="platform-status-heading"
      className="rounded-xl border border-border bg-card p-6 shadow-xs space-y-4 scroll-mt-24"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-500 ring-4 ring-emerald-500/20" />
            <span className="text-xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
              Workspace Ready
            </span>
          </div>
          <h1
            id="platform-status-heading"
            className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground"
          >
            Local Job Tracker
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1.5 py-1 text-xs">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>Local & Private</span>
          </Badge>
        </div>
      </div>

      <div className="rounded-lg border border-border/60 bg-muted/30 p-4 space-y-2 text-sm text-muted-foreground">
        <p className="flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
          <span>
            Deterministic local application pipeline: clip job postings, audit
            fact-grounded tailored resumes, and track your applications end-to-end.
          </span>
        </p>
      </div>
    </section>
  );
}
