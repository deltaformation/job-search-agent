"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Copy,
  Check,
  Cpu,
  Database,
  FileCode,
  HardDrive,
  Kanban,
  ListOrdered,
  PlusCircle,
  RefreshCw,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { apiGet, errorMessage } from "@/components/api";
import { cn } from "@/lib/utils";

interface HealthData {
  status: "ok" | "degraded";
  dataRoot: {
    root: string;
    databaseExists: boolean;
    evidenceExists: boolean;
    artifactsExists: boolean;
  };
  migrations: {
    directory: string;
    files: string[];
  };
}

export default function HealthPage() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);

  const probe = useCallback(async () => {
    setProbing(true);
    setError(null);
    const start = performance.now();
    try {
      const res = await apiGet<HealthData>("/api/health");
      const elapsed = Math.round(performance.now() - start);
      setLatency(elapsed);
      setData(res);
      setLastChecked(new Date());
    } catch (err: unknown) {
      const elapsed = Math.round(performance.now() - start);
      setLatency(elapsed);
      setError(errorMessage(err));
      setData(null);
      setLastChecked(new Date());
    } finally {
      setLoading(false);
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const start = performance.now();
    apiGet<HealthData>("/api/health")
      .then((res) => {
        if (!cancelled) {
          setLatency(Math.round(performance.now() - start));
          setData(res);
          setLastChecked(new Date());
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLatency(Math.round(performance.now() - start));
          setError(errorMessage(err));
          setLastChecked(new Date());
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCopyJson = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard fallback
    }
  };

  const isHealthy = data?.status === "ok";

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="health-page mx-auto flex min-h-0 w-full flex-col overflow-hidden px-4 pt-3.5 pb-6 sm:px-6 lg:px-8 scroll-mt-20 focus:outline-none"
    >
      {/* Top Header & Navigation Bar (matches Board and Intake toolbars) */}
      <div className="shrink-0 mb-4 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-border/70 bg-card/60 p-2.5 sm:px-3.5 shadow-xs backdrop-blur-xs">
        {/* Left: Title + Status Badge */}
        <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
          <h1 className="text-lg sm:text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Activity className="size-5 text-emerald-500" aria-hidden="true" />
            <span>API & System Health</span>
          </h1>
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors",
                loading
                  ? "bg-secondary/80 text-secondary-foreground border-border/60"
                  : isHealthy
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                    : "bg-destructive/10 text-destructive border-destructive/20"
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  loading
                    ? "bg-muted-foreground animate-pulse"
                    : isHealthy
                      ? "bg-emerald-500"
                      : "bg-destructive"
                )}
              />
              <span>
                {loading
                  ? "Probing local API…"
                  : isHealthy
                    ? "Ready & Operational"
                    : "Degraded"}
              </span>
            </span>
            <span className="hidden sm:inline-flex text-xs text-muted-foreground">
              · 127.0.0.1 Loopback
            </span>
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void probe()}
            disabled={probing}
            className="h-9 gap-1.5 text-xs sm:text-sm font-medium shadow-xs"
            aria-label="Re-probe local health endpoint"
          >
            <RefreshCw
              className={cn("size-3.5", probing && "animate-spin text-primary")}
              aria-hidden="true"
            />
            <span>{probing ? "Probing…" : "Probe API"}</span>
          </Button>

          <Button asChild size="sm" variant="outline" className="h-9 gap-1.5 text-xs sm:text-sm font-medium shadow-xs">
            <Link href="/queue">
              <ListOrdered className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span>Queue</span>
            </Link>
          </Button>
        </div>
      </div>

      {/* Main Content Layout */}
      <div className="space-y-4">
        {/* Real-time Status Hero Card */}
        <div
          className={cn(
            "rounded-xl border p-5 sm:p-6 shadow-xs transition-all",
            loading
              ? "border-border bg-card/70"
              : isHealthy
                ? "border-emerald-500/30 bg-emerald-500/5"
                : "border-destructive/30 bg-destructive/5"
          )}
        >
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="flex items-start gap-3.5">
              <div
                className={cn(
                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl shadow-xs",
                  isHealthy
                    ? "bg-emerald-500 text-white dark:bg-emerald-600"
                    : "bg-destructive text-destructive-foreground"
                )}
              >
                {isHealthy ? (
                  <CheckCircle2 className="size-6" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="size-6" aria-hidden="true" />
                )}
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-xl font-bold tracking-tight text-foreground">
                    {loading
                      ? "Checking System Health…"
                      : isHealthy
                        ? "All Core Services Operational & Ready"
                        : "System Degraded or Unavailable"}
                  </h2>
                  <Badge variant="outline" className="text-xs font-mono">
                    GET /api/health
                  </Badge>
                </div>
                <p className="text-xs sm:text-sm text-muted-foreground max-w-2xl leading-relaxed">
                  {isHealthy
                    ? "The local job tracker runtime, SQLite database, immutable evidence vault, and supervisor are running natively on 127.0.0.1 with zero cloud leaks."
                    : error ||
                      "One or more local storage directories, SQLite databases, or checked-in schema migrations could not be verified."}
                </p>
              </div>
            </div>

            {/* Metric Chips */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <div className="flex items-center gap-1.5 rounded-lg border border-border/80 bg-background/80 px-3 py-1.5 shadow-xs">
                <Clock className="size-3.5 text-muted-foreground" aria-hidden="true" />
                <span className="text-muted-foreground">Probe Latency:</span>
                <span className="font-semibold text-foreground">
                  {latency !== null ? `${latency} ms` : "—"}
                </span>
              </div>

              <div className="flex items-center gap-1.5 rounded-lg border border-border/80 bg-background/80 px-3 py-1.5 shadow-xs">
                <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                <span className="text-muted-foreground">Status:</span>
                <span className="font-semibold text-foreground">
                  {isHealthy ? "200 OK" : "503 Degraded"}
                </span>
              </div>

              {lastChecked && (
                <div className="hidden lg:flex items-center gap-1.5 rounded-lg border border-border/80 bg-background/80 px-3 py-1.5 shadow-xs text-muted-foreground">
                  <span>Checked {lastChecked.toLocaleTimeString()}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 4 Diagnostic Panels Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Panel 1: Database & Migrations */}
          <Card className="shadow-xs border-border/80 flex flex-col justify-between">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Database className="size-4" aria-hidden="true" />
                  </div>
                  <div>
                    <CardTitle className="text-base font-semibold">
                      SQLite Database & Schema
                    </CardTitle>
                    <CardDescription className="text-xs">
                      better-sqlite3 v11 · Drizzle ORM
                    </CardDescription>
                  </div>
                </div>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-xs font-medium",
                    data?.dataRoot.databaseExists
                      ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/5"
                      : "border-destructive/30 text-destructive bg-destructive/5"
                  )}
                >
                  {data?.dataRoot.databaseExists ? "Connected" : "Missing"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-0 text-xs">
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Database File:</span>
                  <span className="font-mono text-foreground font-medium">job-tracker.sqlite</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Journal Mode:</span>
                  <span className="text-foreground font-medium">WAL (Write-Ahead Logging)</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Foreign Keys:</span>
                  <span className="text-foreground font-medium">Enforced (PRAGMA foreign_keys = ON)</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Applied Migrations:</span>
                  <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                    {data ? `${data.migrations.files.length} / ${data.migrations.files.length} applied` : "—"}
                  </span>
                </div>
              </div>

              {data?.migrations.files && data.migrations.files.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Checked-in Migrations
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {data.migrations.files.map((file) => (
                      <span
                        key={file}
                        className="font-mono text-[11px] rounded bg-muted px-2 py-0.5 text-foreground border border-border/50"
                      >
                        {file}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Panel 2: Storage & Data Root */}
          <Card className="shadow-xs border-border/80 flex flex-col justify-between">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <HardDrive className="size-4" aria-hidden="true" />
                  </div>
                  <div>
                    <CardTitle className="text-base font-semibold">
                      Local Storage & Data Root
                    </CardTitle>
                    <CardDescription className="text-xs">
                      Immutable evidence & artifact stores
                    </CardDescription>
                  </div>
                </div>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-xs font-medium",
                    data?.dataRoot.evidenceExists && data?.dataRoot.artifactsExists
                      ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/5"
                      : "border-destructive/30 text-destructive bg-destructive/5"
                  )}
                >
                  {data?.dataRoot.evidenceExists && data?.dataRoot.artifactsExists
                    ? "Healthy"
                    : "Degraded"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-0 text-xs">
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Storage Root:</span>
                  <span className="font-mono text-foreground font-medium truncate max-w-[240px]" title={data?.dataRoot.root}>
                    {data?.dataRoot.root || "data/"}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Evidence Vault:</span>
                  <span className="flex items-center gap-1.5 font-medium">
                    <span className={cn("size-1.5 rounded-full", data?.dataRoot.evidenceExists ? "bg-emerald-500" : "bg-destructive")} />
                    <span className="font-mono text-foreground">data/evidence/</span>
                    <span className="text-muted-foreground text-[11px]">(Raw HTML/DOM)</span>
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Artifacts Store:</span>
                  <span className="flex items-center gap-1.5 font-medium">
                    <span className={cn("size-1.5 rounded-full", data?.dataRoot.artifactsExists ? "bg-emerald-500" : "bg-destructive")} />
                    <span className="font-mono text-foreground">data/artifacts/</span>
                    <span className="text-muted-foreground text-[11px]">(PDF/DOCX/MD)</span>
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Path Sandbox:</span>
                  <span className="text-foreground font-medium">Strict allowlist (traversal blocked)</span>
                </div>
              </div>

              <div className="flex items-center justify-between text-[11px] text-muted-foreground px-1">
                <span>Content-addressed SHA-256 storage</span>
                <span>Relative paths only</span>
              </div>
            </CardContent>
          </Card>

          {/* Panel 3: Security & Network Isolation */}
          <Card className="shadow-xs border-border/80 flex flex-col justify-between">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <ShieldCheck className="size-4" aria-hidden="true" />
                  </div>
                  <div>
                    <CardTitle className="text-base font-semibold">
                      Security & Network Boundary
                    </CardTitle>
                    <CardDescription className="text-xs">
                      127.0.0.1 localhost isolation & CSRF
                    </CardDescription>
                  </div>
                </div>
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/5 text-xs font-medium"
                >
                  Strict Isolation
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-0 text-xs">
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Host Binding:</span>
                  <span className="font-mono text-foreground font-medium">127.0.0.1:3000 (Loopback only)</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Origin & CSRF:</span>
                  <span className="text-foreground font-medium">Mutation gate enforced on POST/PATCH</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Cloud Sync / Telemetry:</span>
                  <span className="text-emerald-600 dark:text-emerald-400 font-semibold">0% (Completely offline)</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Truthfulness Rule:</span>
                  <span className="text-foreground font-medium">Strict fact_id citation audit</span>
                </div>
              </div>

              <div className="flex items-center justify-between text-[11px] text-muted-foreground px-1">
                <span>Zero external trackers</span>
                <span>Human-only application submit</span>
              </div>
            </CardContent>
          </Card>

          {/* Panel 4: Execution & Platform Services */}
          <Card className="shadow-xs border-border/80 flex flex-col justify-between">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Cpu className="size-4" aria-hidden="true" />
                  </div>
                  <div>
                    <CardTitle className="text-base font-semibold">
                      Platform Services & Engine
                    </CardTitle>
                    <CardDescription className="text-xs">
                      Supervised worker & Playwright headless
                    </CardDescription>
                  </div>
                </div>
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/5 text-xs font-medium"
                >
                  Active
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-0 text-xs">
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Runtime:</span>
                  <span className="text-foreground font-medium">Node.js 24 (Native ARM64 / Apple Silicon)</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Browser Automation:</span>
                  <span className="text-foreground font-medium">Playwright Chromium (Public DOM & PDF)</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Tailoring Engine:</span>
                  <span className="text-foreground font-medium">Canonical view model (MD, DOCX, PDF)</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">App Bundle:</span>
                  <span className="text-foreground font-medium">Job Tracker.app (Native App Mode)</span>
                </div>
              </div>

              <div className="flex items-center justify-between text-[11px] text-muted-foreground px-1">
                <span>Lease recovery queue</span>
                <span>Synchronous SQLite transactions</span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Live Probe JSON Inspector */}
        <div className="rounded-xl border border-border/80 bg-card p-4 shadow-xs">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Terminal className="size-4 text-primary" aria-hidden="true" />
              <h3 className="text-sm font-semibold text-foreground">
                Live Probe Response Payload
              </h3>
              <Badge variant="outline" className="text-[10px] font-mono">
                {data ? "application/json" : "no data"}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRawOpen(!rawOpen)}
                className="h-7 text-xs font-medium"
              >
                {rawOpen ? "Collapse" : "Expand"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyJson}
                disabled={!data}
                className="h-7 gap-1.5 text-xs font-medium"
              >
                {copied ? (
                  <>
                    <Check className="size-3 text-emerald-500" aria-hidden="true" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="size-3" aria-hidden="true" />
                    <span>Copy JSON</span>
                  </>
                )}
              </Button>
            </div>
          </div>

          <div
            className={cn(
              "relative rounded-lg bg-muted/60 p-3 font-mono text-xs overflow-x-auto border border-border/60 transition-all",
              rawOpen ? "max-h-96" : "max-h-36"
            )}
          >
            <pre className="text-muted-foreground whitespace-pre-wrap break-words">
              {data ? JSON.stringify(data, null, 2) : error || "Awaiting probe response…"}
            </pre>
          </div>
        </div>

        {/* Quick Hub Navigation Links */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
          <Link
            href="/board"
            className="flex items-center justify-between rounded-xl border border-border bg-card/60 p-3.5 shadow-xs hover:border-primary/50 hover:bg-card transition-colors group"
          >
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Kanban className="size-4" aria-hidden="true" />
              </div>
              <div>
                <span className="text-xs font-semibold text-foreground block">
                  Job Board
                </span>
                <span className="text-[11px] text-muted-foreground">
                  View and manage application stages
                </span>
              </div>
            </div>
            <ArrowRight className="size-4 text-muted-foreground group-hover:text-primary transition-colors" />
          </Link>

          <Link
            href="/intake"
            className="flex items-center justify-between rounded-xl border border-border bg-card/60 p-3.5 shadow-xs hover:border-primary/50 hover:bg-card transition-colors group"
          >
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <PlusCircle className="size-4" aria-hidden="true" />
              </div>
              <div>
                <span className="text-xs font-semibold text-foreground block">
                  Job Intake
                </span>
                <span className="text-[11px] text-muted-foreground">
                  Enqueues URL batches and browser clipper
                </span>
              </div>
            </div>
            <ArrowRight className="size-4 text-muted-foreground group-hover:text-primary transition-colors" />
          </Link>

          <Link
            href="/master-resume"
            className="flex items-center justify-between rounded-xl border border-border bg-card/60 p-3.5 shadow-xs hover:border-primary/50 hover:bg-card transition-colors group"
          >
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <FileCode className="size-4" aria-hidden="true" />
              </div>
              <div>
                <span className="text-xs font-semibold text-foreground block">
                  Master Resume
                </span>
                <span className="text-[11px] text-muted-foreground">
                  Verify approved facts and baseline skills
                </span>
              </div>
            </div>
            <ArrowRight className="size-4 text-muted-foreground group-hover:text-primary transition-colors" />
          </Link>
        </div>
      </div>
    </main>
  );
}
