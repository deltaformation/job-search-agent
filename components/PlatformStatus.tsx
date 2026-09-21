import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, CheckCircle2, Database, HardDrive, ShieldCheck } from "lucide-react";

export default function PlatformStatus() {
  return (
    <section
      id="platform-status"
      aria-labelledby="platform-status-heading"
      className="rounded-xl border border-border/80 bg-card p-5 sm:p-6 shadow-xs space-y-4 scroll-mt-24"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
            </span>
            <span className="text-xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
              Workspace Ready
            </span>
            <span className="text-xs text-muted-foreground">· 127.0.0.1</span>
          </div>
          <h1
            id="platform-status-heading"
            className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground"
          >
            Local Job Tracker
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm" className="h-8 gap-1.5 text-xs font-medium shadow-xs">
            <Link href="/health">
              <Activity className="size-3.5 text-emerald-500" aria-hidden="true" />
              <span>System & API Health</span>
            </Link>
          </Button>
          <Badge variant="outline" className="gap-1.5 py-1 text-xs">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>Local & Private</span>
          </Badge>
        </div>
      </div>

      <div className="rounded-lg border border-border/60 bg-muted/30 p-3.5 space-y-2 text-xs sm:text-sm text-muted-foreground">
        <p className="flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
          <span className="leading-relaxed">
            Deterministic local application pipeline: clip job postings, audit
            fact-grounded tailored resumes, and track your applications end-to-end.
          </span>
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-xs">
          <Database className="size-3.5 text-primary shrink-0" />
          <div className="min-w-0">
            <span className="text-muted-foreground block text-[10px]">Database</span>
            <span className="font-semibold text-foreground truncate block">SQLite (WAL)</span>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-xs">
          <HardDrive className="size-3.5 text-primary shrink-0" />
          <div className="min-w-0">
            <span className="text-muted-foreground block text-[10px]">Data Root</span>
            <span className="font-semibold text-foreground truncate block">data/ (Vault)</span>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-xs">
          <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <div className="min-w-0">
            <span className="text-muted-foreground block text-[10px]">Sandbox</span>
            <span className="font-semibold text-foreground truncate block">127.0.0.1 Air-Gapped</span>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-xs">
          <Activity className="size-3.5 text-emerald-500 shrink-0" />
          <div className="min-w-0">
            <span className="text-muted-foreground block text-[10px]">Probe Status</span>
            <span className="font-semibold text-emerald-600 dark:text-emerald-400 truncate block">Operational</span>
          </div>
        </div>
      </div>
    </section>
  );
}
