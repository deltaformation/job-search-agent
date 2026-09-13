"use client";

import { useEffect, useRef, useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Notice, useNotice } from "@/components/ui/notice";
import { cn } from "@/lib/utils";
import { apiGet, apiPost, errorMessage } from "../api";

/**
 * Settings and data-management modal (R5-A): backup download, archive
 * restore, board reset, AI provider + model chains, connection
 * diagnostics, profile quick-view with master-resume re-sync, and
 * storage stats. API keys themselves are never fetched or displayed —
 * only per-provider fingerprints.
 */

type AiProviderId = "openrouter" | "google" | "meta";

interface ProviderSnapshot {
  configured: boolean;
  fingerprint: string | null;
  models: { primary: string; fallback: string };
}

interface SettingsSnapshot {
  models: { primary: string; fallback: string };
  activeProvider: AiProviderId;
  providers: Record<AiProviderId, ProviderSnapshot>;
  openRouter: { configured: boolean; fingerprint: string | null };
  profile: {
    activeVersion: number;
    displayName: string | null;
    approvedFacts: number;
    verifiedSkills: number;
  } | null;
  storage: {
    databaseBytes: number;
    walBytes: number;
    jobCount: number;
    evidenceBytes: number;
    evidenceFiles: number;
    artifactBytes: number;
    artifactFiles: number;
    backupCount: number;
    backupsBytes: number;
  };
}

interface AiTestResult {
  ok: boolean;
  model: string | null;
  latencyMs: number;
  error: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

const AI_PROVIDERS: Array<{
  id: AiProviderId;
  name: string;
  keyName: string;
  primaryPlaceholder: string;
  fallbackPlaceholder: string;
}> = [
  {
    id: "openrouter",
    name: "OpenRouter",
    keyName: "OPENROUTER_API_KEY",
    primaryPlaceholder: "google/gemma-4-26b-a4b-it:free",
    fallbackPlaceholder: "nvidia/nemotron-3.5-lightning:free",
  },
  {
    id: "google",
    name: "Google AI Studio",
    keyName: "GEMINI_API_KEY",
    primaryPlaceholder: "gemini-2.5-pro",
    fallbackPlaceholder: "gemini-2.5-flash",
  },
  {
    id: "meta",
    name: "Meta Muse",
    keyName: "META_API_KEY",
    primaryPlaceholder: "meta-muse",
    fallbackPlaceholder: "(optional second model)",
  },
];

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-3 rounded-lg border border-border p-4">
      <h3 className="text-base font-semibold tracking-tight text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

export default function SettingsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const settingsNotice = useNotice<{ type: "success" | "error"; text: string }>();
  const [selectedProvider, setSelectedProvider] = useState<AiProviderId>("openrouter");
  const [primary, setPrimary] = useState("");
  const [fallback, setFallback] = useState("");
  const [aiResult, setAiResult] = useState<AiTestResult | null>(null);
  const [resetArmed, setResetArmed] = useState(false);
  const [resetConfirm, setResetConfirm] = useState("");
  const [dataSwapped, setDataSwapped] = useState(false);
  const sectionScrollRef = useRef<HTMLDivElement>(null);

  function onSectionChange(): void {
    // Section switches start at the top: without a reset, the newly
    // shown panel inherits the previous scroll offset and opens
    // mid-section. Instant (not smooth): tab swaps are state changes.
    if (sectionScrollRef.current !== null) {
      sectionScrollRef.current.scrollTop = 0;
    }
  }

  function applySnapshot(data: SettingsSnapshot): void {
    setSnapshot(data);
    const provider = data.activeProvider ?? "openrouter";
    setSelectedProvider(provider);
    setPrimary(data.providers?.[provider]?.models.primary ?? data.models.primary);
    setFallback(data.providers?.[provider]?.models.fallback ?? data.models.fallback);
  }

  async function refresh(): Promise<void> {
    setLoadError(null);
    try {
      applySnapshot(await apiGet<SettingsSnapshot>("/api/settings"));
    } catch (error: unknown) {
      setLoadError(errorMessage(error));
    }
  }

  function selectProvider(provider: AiProviderId): void {
    setSelectedProvider(provider);
    setAiResult(null);
    const chain = snapshot?.providers?.[provider]?.models;
    if (chain !== undefined) {
      setPrimary(chain.primary);
      setFallback(chain.fallback);
    }
  }

  function handleOpenChange(next: boolean): void {
    if (!next) {
      // Reset on close (an event handler, not an effect) so every
      // opening starts fresh without setState-in-effect.
      setSnapshot(null);
      settingsNotice.clear();
      setAiResult(null);
      setResetArmed(false);
      setResetConfirm("");
      setDataSwapped(false);
      setLoadError(null);
    }
    onOpenChange(next);
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    apiGet<SettingsSnapshot>("/api/settings").then(
      (data) => {
        if (cancelled) {
          return;
        }
        applySnapshot(data);
      },
      (error: unknown) => {
        if (!cancelled) {
          setLoadError(errorMessage(error));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open ]);

  async function run(action: string, fn: () => Promise<string>): Promise<void> {
    setBusy(action);
    settingsNotice.clear();
    try {
      settingsNotice.show({ type: "success", text: await fn() });
    } catch (error: unknown) {
      settingsNotice.show({ type: "error", text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function downloadBackup(): Promise<void> {
    await run("backup", async () => {
      const response = await fetch("/api/backup", { method: "GET" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
          reason?: string;
        } | null;
        throw new Error(
          body?.reason ?? body?.error ?? `backup failed (${response.status})`,
        );
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? "job-tracker-backup.tar.gz";
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
      await refresh();
      return `Backup downloaded: ${filename}`;
    });
  }

  async function uploadRestore(file: File): Promise<void> {
    await run("restore", async () => {
      const form = new FormData();
      form.append("archive", file, file.name);
      const response = await fetch("/api/restore", { method: "POST", body: form });
      const body = (await response.json().catch(() => null)) as {
        jobs?: number;
        preRestoreBackup?: string;
        error?: string;
        reason?: string;
      } | null;
      if (!response.ok) {
        throw new Error(body?.reason ?? body?.error ?? `restore failed (${response.status})`);
      }
      setDataSwapped(true);
      await refresh();
      return `Restored ${body?.jobs ?? "?"} jobs. Rollback backup: ${body?.preRestoreBackup ?? "?"}. Reload the app to see restored data.`;
    });
  }

  async function submitReset(): Promise<void> {
    await run("reset", async () => {
      const body = await apiPost<{
        deletedJobs: number;
        preResetBackup: string;
        preservedProfile: boolean;
      }>("/api/jobs/reset", { confirm: "RESET" });
      setDataSwapped(true);
      setResetArmed(false);
      setResetConfirm("");
      await refresh();
      return `Board cleared (${body.deletedJobs} jobs removed). Safety backup: ${body.preResetBackup}. Reload the app to see the empty board.`;
    });
  }

  async function switchModelChain(): Promise<void> {
    await run("models", async () => {
      const payload: Record<string, string> =
        selectedProvider === "google"
          ? { provider: selectedProvider, googleModel: primary, googleFallbackModel: fallback }
          : selectedProvider === "meta"
            ? { provider: selectedProvider, metaModel: primary, metaFallbackModel: fallback }
            : { provider: selectedProvider, primary, fallback };
      const body = await apiPost<{ primary: string; fallback: string; restartRequired: boolean }>(
        "/api/settings/model",
        payload,
      );
      await refresh();
      return `Model chain saved (${body.primary} / ${body.fallback}). Restart the app to apply it.`;
    });
  }

  async function testAi(): Promise<void> {
    await run("ai-test", async () => {
      const result = await apiPost<AiTestResult>("/api/settings/ai-test", {
        provider: selectedProvider,
      });
      setAiResult(result);
      return result.ok
        ? `Ping ok: ${result.model} in ${result.latencyMs} ms`
        : `Ping failed: ${result.error ?? "unknown error"}`;
    });
  }

  async function resyncProfile(): Promise<void> {
    await run("resync", async () => {
      const body = await apiPost<{
        ok: boolean;
        versionId: string;
        version: number;
        alreadyCurrent: boolean;
      }>("/api/settings/resync", {});
      await refresh();
      return body.alreadyCurrent
        ? `Profile already current (version ${body.version}).`
        : `Profile re-synced to version ${body.version}.`;
    });
  }

  const storage = snapshot?.storage ?? null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="settings-panel flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SettingsIcon className="size-5 text-primary" aria-hidden="true" />
            Settings & Data Management
          </DialogTitle>
          <DialogDescription>
            Backups, restore, board reset, AI models, profile, and storage.
          </DialogDescription>
        </DialogHeader>

        {loadError !== null && (
          <Notice
            variant="error"
            onDismiss={() => setLoadError(null)}
            className="rounded-md bg-destructive/10 p-3 text-xs text-destructive"
          >
            Could not load settings: {loadError}
          </Notice>
        )}

        {settingsNotice.notice !== null && (
          <Notice
            key={settingsNotice.notice.seq}
            variant={settingsNotice.notice.data.type}
            onDismiss={settingsNotice.clear}
            className={cn(
              "rounded-md p-3 text-xs",
              settingsNotice.notice.data.type === "success"
                ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300"
                : "bg-destructive/10 text-destructive",
            )}
          >
            {settingsNotice.notice.data.text}
          </Notice>
        )}

        {dataSwapped && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <span>The database was replaced. Reload the app to see current data.</span>
            <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
              Reload app
            </Button>
          </div>
        )}

        <Tabs defaultValue="data" onValueChange={onSectionChange} className="flex min-h-0 flex-1 flex-col gap-5">
          <TabsList aria-label="Settings sections" className="h-auto shrink-0 flex-wrap justify-start gap-1">
            <TabsTrigger value="data">Data & Backup</TabsTrigger>
            <TabsTrigger value="ai">AI & Models</TabsTrigger>
            <TabsTrigger value="profile">Candidate Profile</TabsTrigger>
          </TabsList>
          <div ref={sectionScrollRef} className="settings-scroll min-h-0 flex-1 overflow-y-auto">
            <TabsContent value="data" className="workspace-tab mt-0 min-h-[400px] space-y-6">
          <Section title="Backup & Restore">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void downloadBackup()} disabled={busy !== null}>
                {busy === "backup" ? "Preparing…" : "Download Backup"}
              </Button>
              <label
                htmlFor="settings-restore-file"
                className={cn(
                  "inline-flex h-8 cursor-pointer items-center rounded-md border border-input bg-background px-3 text-xs font-medium",
                  busy !== null && "pointer-events-none opacity-50",
                )}
              >
                {busy === "restore" ? "Restoring…" : "Restore from File…"}
              </label>
              <input
                id="settings-restore-file"
                type="file"
                accept=".tar.gz,application/gzip"
                className="sr-only"
                disabled={busy !== null}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) {
                    void uploadRestore(file);
                  }
                }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Backups contain the database, evidence, artifacts, and candidate profile — never
              secrets. Restore always writes a rollback backup first.
            </p>
          </Section>
          <Section title="Storage">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">Database</dt>
                <dd className="font-mono tabular-nums font-medium">
                  {storage === null ? "…" : formatBytes(storage.databaseBytes + storage.walBytes)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Jobs</dt>
                <dd className="font-mono tabular-nums font-medium">{storage === null ? "…" : storage.jobCount}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Evidence</dt>
                <dd className="font-mono tabular-nums font-medium">
                  {storage === null
                    ? "…"
                    : `${formatBytes(storage.evidenceBytes)} · ${storage.evidenceFiles} files`}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Artifacts</dt>
                <dd className="font-mono tabular-nums font-medium">
                  {storage === null
                    ? "…"
                    : `${formatBytes(storage.artifactBytes)} · ${storage.artifactFiles} files`}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Backups</dt>
                <dd className="font-mono tabular-nums font-medium">
                  {storage === null
                    ? "…"
                    : `${storage.backupCount} · ${formatBytes(storage.backupsBytes)}`}
                </dd>
              </div>
            </dl>
          </Section>
              <div className="border-t border-border/40 pt-6">
          <Section title="Board Reset">
            {!resetArmed ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setResetArmed(true)}
                disabled={busy !== null}
              >
                Clear All Jobs…
              </Button>
            ) : (
              <div className="space-y-2">
                <p className="text-xs">
                  This removes every job, extraction, and resume version. The candidate profile
                  is kept, and a safety backup is written first. Type{" "}
                  <kbd className="rounded border border-border bg-muted px-1 font-mono tabular-nums">
                    RESET
                  </kbd>{" "}
                  to confirm.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor="settings-reset-confirm" className="sr-only">
                    Type RESET to confirm board reset
                  </label>
                  <input
                    id="settings-reset-confirm"
                    type="text"
                    autoComplete="off"
                    value={resetConfirm}
                    onChange={(event) => setResetConfirm(event.target.value)}
                    placeholder="RESET"
                    className="h-8 w-32 rounded-md border border-input bg-background px-3 text-sm"
                  />
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy !== null || resetConfirm !== "RESET"}
                    onClick={() => void submitReset()}
                  >
                    {busy === "reset" ? "Clearing…" : "Confirm Reset"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => {
                      setResetArmed(false);
                      setResetConfirm("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </Section>
              </div>
            </TabsContent>
            <TabsContent value="ai" className="workspace-tab mt-0 min-h-[400px]">
          <Section title="AI Providers">
            <div role="radiogroup" aria-label="Active AI provider" className="grid gap-2 sm:grid-cols-3">
              {AI_PROVIDERS.map((item) => {
                const status = snapshot?.providers?.[item.id];
                const selected = selectedProvider === item.id;
                const running = snapshot?.activeProvider === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => selectProvider(item.id)}
                    className={cn(
                      "rounded-lg border p-3 text-left transition-colors",
                      selected
                        ? "border-primary bg-primary/5 shadow-xs"
                        : "border-border hover:bg-muted/50",
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-xs font-semibold">
                      {item.name}
                      {running && (
                        <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-semibold text-primary">
                          Active
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block text-[11px]">
                      {status === undefined ? (
                        <span className="text-muted-foreground">…</span>
                      ) : status.configured ? (
                        <span className="font-medium text-emerald-600 dark:text-emerald-400">
                          Connected · {status.fingerprint}
                        </span>
                      ) : (
                        <span className="font-medium text-amber-600 dark:text-amber-400">
                          Key Missing in .env.local
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block font-mono tabular-nums text-[10px] text-muted-foreground">
                      {item.keyName}
                    </span>
                  </button>
                );
              })}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Primary</dt>
              <dd className="break-all font-mono tabular-nums text-[11px]">{snapshot?.providers?.[selectedProvider]?.models.primary ?? "…"}</dd>
              <dt className="text-muted-foreground">Fallback</dt>
              <dd className="break-all font-mono tabular-nums text-[11px]">{snapshot?.providers?.[selectedProvider]?.models.fallback ?? "…"}</dd>
            </dl>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor="settings-model-primary" className="text-[11px] font-medium">
                  Primary model
                </label>
                <input
                  id="settings-model-primary"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={AI_PROVIDERS.find((item) => item.id === selectedProvider)?.primaryPlaceholder}
                  value={primary}
                  onChange={(event) => setPrimary(event.target.value)}
                  className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 font-mono tabular-nums text-[11px] placeholder:text-muted-foreground/60"
                />
              </div>
              <div>
                <label htmlFor="settings-model-fallback" className="text-[11px] font-medium">
                  Fallback model
                </label>
                <input
                  id="settings-model-fallback"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={AI_PROVIDERS.find((item) => item.id === selectedProvider)?.fallbackPlaceholder}
                  value={fallback}
                  onChange={(event) => setFallback(event.target.value)}
                  className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 font-mono tabular-nums text-[11px] placeholder:text-muted-foreground/60"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void switchModelChain()} disabled={busy !== null}>
                {busy === "models" ? "Saving…" : "Save Models"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void testAi()} disabled={busy !== null}>
                {busy === "ai-test" ? "Pinging…" : "Test Connection"}
              </Button>
              {aiResult !== null && (
                <span className="text-[11px] text-muted-foreground">
                  {aiResult.ok
                    ? `✓ Connected (${aiResult.latencyMs} ms, ${aiResult.model})`
                    : `Failed: ${aiResult.error ?? "unknown"}`}
                </span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Saving edits <span className="font-mono tabular-nums">.env.local</span>; restart the app to apply.
              API key values are never shown.
            </p>
          </Section>
            </TabsContent>
            <TabsContent value="profile" className="workspace-tab mt-0 min-h-[400px]">
          <Section title="Candidate Profile">
            {snapshot?.profile === null || snapshot?.profile === undefined ? (
              <p className="text-xs text-muted-foreground">
                No active profile. Add <span className="font-mono tabular-nums">data/candidate/master-resume.json</span> then re-sync.
              </p>
            ) : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="font-medium">{snapshot.profile.displayName ?? "—"}</dd>
                <dt className="text-muted-foreground">Active version</dt>
                <dd className="font-mono tabular-nums font-medium">v{snapshot.profile.activeVersion}</dd>
                <dt className="text-muted-foreground">Approved facts</dt>
                <dd className="font-mono tabular-nums font-medium">{snapshot.profile.approvedFacts}</dd>
                <dt className="text-muted-foreground">Verified skills</dt>
                <dd className="font-mono tabular-nums font-medium">{snapshot.profile.verifiedSkills}</dd>
              </dl>
            )}
            <Button size="sm" variant="outline" onClick={() => void resyncProfile()} disabled={busy !== null}>
              {busy === "resync" ? "Re-syncing…" : "Re-sync Master Resume"}
            </Button>
          </Section>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
