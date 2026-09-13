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
import { apiGet, apiPatch, apiPost, errorMessage } from "../api";

/**
 * Settings and data-management modal (R5-A): backup download, archive
 * restore, board reset, AI provider + model chains, connection
 * diagnostics, career profiles + master-resume management with
 * re-sync, and storage stats. API keys themselves are never fetched or
 * displayed — only per-provider fingerprints.
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
    activeVersionAt: string;
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

/** Client mirror of the server `ProfileSummary` (steering metadata only). */
interface ProfileWorkPreferences {
  workAuthorization: string[];
  workMode: string[];
  sponsorshipRequired: boolean;
  willingToRelocate: boolean;
  yearsOfExperience?: number;
  salaryExpectation?: { min?: number; target?: number; currency?: string };
  targetTitles: string[];
  targetLocations: string[];
}

interface ProfileSummary {
  id: string;
  name: string;
  displayName: string;
  isDefault: boolean;
  workPreferences: ProfileWorkPreferences | null;
  executiveNarrative: string | null;
  versionCount: number;
  latestVersion: number | null;
  latestVersionAt: string | null;
  activeVersion: number | null;
  approvedFacts: number;
}

/** Values the profile form collects; merged over preserved preferences. */
interface ProfileFormValues {
  name: string;
  displayName: string;
  workMode: string[];
  workAuthorization: string;
  sponsorshipRequired: boolean;
  willingToRelocate: boolean;
  yearsOfExperience: string;
  salaryMin: string;
  salaryTarget: string;
  salaryCurrency: string;
  executiveNarrative: string;
}

function profileFormDefaults(profile: ProfileSummary | null): ProfileFormValues {
  const prefs = profile?.workPreferences ?? null;
  return {
    name: profile?.name ?? "",
    displayName: profile?.displayName ?? "",
    workMode: prefs === null ? [] : [...prefs.workMode],
    workAuthorization: prefs === null ? "" : prefs.workAuthorization.join(", "),
    sponsorshipRequired: prefs?.sponsorshipRequired ?? false,
    willingToRelocate: prefs?.willingToRelocate ?? false,
    yearsOfExperience:
      prefs?.yearsOfExperience === undefined ? "" : String(prefs.yearsOfExperience),
    salaryMin:
      prefs?.salaryExpectation?.min === undefined ? "" : String(prefs.salaryExpectation.min),
    salaryTarget:
      prefs?.salaryExpectation?.target === undefined
        ? ""
        : String(prefs.salaryExpectation.target),
    salaryCurrency: prefs?.salaryExpectation?.currency ?? "",
    executiveNarrative: profile?.executiveNarrative ?? "",
  };
}

function parseOptionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
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
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  /** null = list only; "new" = create form; profile id = edit form. */
  const [profileForm, setProfileForm] = useState<string | null>(null);
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

  async function refreshProfiles(): Promise<void> {
    setProfilesError(null);
    try {
      const data = await apiGet<{ profiles: ProfileSummary[] }>("/api/settings/profiles");
      setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
    } catch (error: unknown) {
      setProfilesError(errorMessage(error));
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
      setProfiles(null);
      setProfilesError(null);
      setProfileForm(null);
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
    apiGet<{ profiles: ProfileSummary[] }>("/api/settings/profiles").then(
      (data) => {
        if (!cancelled) {
          setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setProfilesError(errorMessage(error));
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
      await refreshProfiles();
      return body.alreadyCurrent
        ? `Profile already current (version ${body.version}).`
        : `Profile re-synced to version ${body.version}.`;
    });
  }

  async function setDefaultProfile(id: string, name: string): Promise<void> {
    await run("profile-default", async () => {
      await apiPost(`/api/settings/profiles/${id}/set-default`, {});
      await refresh();
      await refreshProfiles();
      return `Default career profile is now “${name}”.`;
    });
  }

  async function saveProfileForm(
    profile: ProfileSummary | null,
    values: ProfileFormValues,
  ): Promise<void> {
    await run("profile-save", async () => {
      const yearsOfExperience = parseOptionalNumber(values.yearsOfExperience);
      const salaryMin = parseOptionalNumber(values.salaryMin);
      const salaryTarget = parseOptionalNumber(values.salaryTarget);
      const currency = values.salaryCurrency.trim();
      const salaryExpectation =
        salaryMin === undefined && salaryTarget === undefined && currency === ""
          ? undefined
          : {
              ...(salaryMin === undefined ? {} : { min: salaryMin }),
              ...(salaryTarget === undefined ? {} : { target: salaryTarget }),
              ...(currency === "" ? {} : { currency }),
            };
      const existing = profile?.workPreferences ?? null;
      // The form manages a subset of preferences; untouched keys
      // (target titles/locations) carry over so an edit never wipes them.
      const workPreferences = {
        workAuthorization: values.workAuthorization
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== ""),
        workMode: values.workMode,
        sponsorshipRequired: values.sponsorshipRequired,
        willingToRelocate: values.willingToRelocate,
        targetTitles: existing?.targetTitles ?? [],
        targetLocations: existing?.targetLocations ?? [],
        ...(yearsOfExperience === undefined ? {} : { yearsOfExperience }),
        ...(salaryExpectation === undefined ? {} : { salaryExpectation }),
      };
      const narrative = values.executiveNarrative.trim();
      const executiveNarrative =
        narrative === ""
          ? profile?.executiveNarrative
            ? null
            : undefined
          : narrative;
      if (profile === null) {
        const created = await apiPost<{ profile: ProfileSummary }>("/api/settings/profiles", {
          name: values.name.trim(),
          displayName: values.displayName.trim(),
          workPreferences,
          ...(executiveNarrative === undefined ? {} : { executiveNarrative }),
        });
        setProfileForm(null);
        await refreshProfiles();
        return `Career profile “${created.profile.displayName}” created.`;
      }
      const updated = await apiPatch<{ profile: ProfileSummary }>(
        `/api/settings/profiles/${profile.id}`,
        {
          displayName: values.displayName.trim(),
          workPreferences,
          ...(executiveNarrative === undefined ? {} : { executiveNarrative }),
        },
      );
      setProfileForm(null);
      await refreshProfiles();
      return `Career profile “${updated.profile.displayName}” updated.`;
    });
  }

  async function uploadMasterResume(file: File): Promise<void> {
    await run("resume-upload", async () => {
      let content: unknown;
      try {
        content = JSON.parse(await file.text()) as unknown;
      } catch {
        throw new Error(`“${file.name}” is not valid JSON.`);
      }
      const body = await apiPost<{
        ok: boolean;
        version: number;
        alreadyCurrent: boolean;
      }>("/api/settings/master-resume", { content });
      await refresh();
      await refreshProfiles();
      return body.alreadyCurrent
        ? `Master resume matches version ${body.version}; nothing changed.`
        : `Master resume saved and re-synced to version ${body.version}.`;
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
            <TabsContent value="profile" className="workspace-tab mt-0 min-h-[400px] space-y-6">
          <Section title="Career Profiles">
            {profilesError !== null && (
              <p role="alert" className="text-xs text-destructive">
                Could not load profiles: {profilesError}{" "}
                <Button size="sm" variant="link" onClick={() => void refreshProfiles()} disabled={busy !== null}>
                  Retry
                </Button>
              </p>
            )}
            {profiles === null && profilesError === null && (
              <p className="text-xs text-muted-foreground">Loading profiles…</p>
            )}
            {profiles !== null && profiles.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No career profiles yet. Create one to scope resume versions and tailoring.
              </p>
            )}
            {profiles !== null && profiles.length > 0 && (
              <ul className="space-y-2">
                {profiles.map((profile) => (
                  <li
                    key={profile.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2"
                  >
                    <div className="min-w-0 flex-1 basis-40">
                      <p className="truncate text-xs font-medium">
                        {profile.displayName}{" "}
                        {profile.isDefault && (
                          <span className="ml-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                            Default
                          </span>
                        )}
                      </p>
                      <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
                        {profile.name} · {profile.versionCount}{" "}
                        {profile.versionCount === 1 ? "version" : "versions"} ·{" "}
                        {profile.approvedFacts} facts
                        {profile.activeVersion !== null &&
                          ` · active v${profile.activeVersion}`}
                      </p>
                    </div>
                    {!profile.isDefault && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => void setDefaultProfile(profile.id, profile.displayName)}
                      >
                        {busy === "profile-default" ? "Switching…" : "Set Default"}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => setProfileForm(profile.id)}
                    >
                      Edit
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {profileForm === null ? (
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || profiles === null}
                  onClick={() => setProfileForm("new")}
                >
                  New Career Profile
                </Button>
              </div>
            ) : (
              <ProfileForm
                key={profileForm}
                profile={
                  profileForm === "new"
                    ? null
                    : (profiles?.find((entry) => entry.id === profileForm) ?? null)
                }
                busy={busy !== null}
                onCancel={() => setProfileForm(null)}
                onSubmit={(values) =>
                  void saveProfileForm(
                    profileForm === "new"
                      ? null
                      : (profiles?.find((entry) => entry.id === profileForm) ?? null),
                    values,
                  )
                }
              />
            )}
            <p className="text-[11px] text-muted-foreground">
              Profiles are steering metadata only — they never add resume claims or bypass fact
              citations.
            </p>
          </Section>
          <Section title="Master Resume Document">
            {snapshot?.profile === null || snapshot?.profile === undefined ? (
              <p className="text-xs text-muted-foreground">
                No active profile. Add <span className="font-mono tabular-nums">data/candidate/master-resume.json</span> then re-sync.
              </p>
            ) : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Candidate</dt>
                <dd className="font-medium">{snapshot.profile.displayName ?? "—"}</dd>
                <dt className="text-muted-foreground">Active version</dt>
                <dd className="font-mono tabular-nums font-medium">v{snapshot.profile.activeVersion}</dd>
                <dt className="text-muted-foreground">Last synced</dt>
                <dd className="font-mono tabular-nums font-medium">
                  {new Date(snapshot.profile.activeVersionAt).toLocaleString()}
                </dd>
                <dt className="text-muted-foreground">Verified skills</dt>
                <dd className="font-mono tabular-nums font-medium">{snapshot.profile.verifiedSkills}</dd>
              </dl>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void resyncProfile()} disabled={busy !== null}>
                {busy === "resync" ? "Re-syncing…" : "Re-sync Master Resume"}
              </Button>
              <a
                href="/api/settings/master-resume"
                download="master-resume.json"
                className={cn(
                  "inline-flex h-8 items-center rounded-md border border-input bg-background px-3 text-xs font-medium",
                  busy !== null && "pointer-events-none opacity-50",
                )}
              >
                Download JSON
              </a>
              <label
                htmlFor="settings-resume-file"
                className={cn(
                  "inline-flex h-8 cursor-pointer items-center rounded-md border border-input bg-background px-3 text-xs font-medium",
                  busy !== null && "pointer-events-none opacity-50",
                )}
              >
                {busy === "resume-upload" ? "Uploading…" : "Upload / Replace…"}
              </label>
              <input
                id="settings-resume-file"
                type="file"
                accept=".json,application/json"
                className="sr-only"
                disabled={busy !== null}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) {
                    void uploadMasterResume(file);
                  }
                }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Uploads replace the master resume only after schema validation, then re-sync
              immediately.
            </p>
          </Section>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

const WORK_MODES = [
  { value: "REMOTE", label: "Remote" },
  { value: "HYBRID", label: "Hybrid" },
  { value: "ONSITE", label: "Onsite" },
] as const;

const FORM_INPUT = "h-8 rounded-md border border-input bg-background px-2 text-xs";
const FORM_LABEL = "text-xs font-medium";

/**
 * Create/edit form for one career profile. Edits keep the frozen slug
 * read-only and merge over the profile's preserved preferences on save
 * (see `saveProfileForm`), so untouched keys survive.
 */
function ProfileForm({
  profile,
  busy,
  onCancel,
  onSubmit,
}: {
  profile: ProfileSummary | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: ProfileFormValues) => void;
}) {
  const [values, setValues] = useState<ProfileFormValues>(() => profileFormDefaults(profile));

  function set<Key extends keyof ProfileFormValues>(
    key: Key,
    value: ProfileFormValues[Key],
  ): void {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function toggleWorkMode(mode: string): void {
    setValues((current) => ({
      ...current,
      workMode: current.workMode.includes(mode)
        ? current.workMode.filter((entry) => entry !== mode)
        : [...current.workMode, mode],
    }));
  }

  return (
    <form
      aria-label={profile === null ? "New career profile" : `Edit ${profile.displayName}`}
      className="space-y-3 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(values);
      }}
    >
      {profile === null && (
        <div className="grid gap-1">
          <label htmlFor="profile-form-name" className={FORM_LABEL}>
            Name (slug)
          </label>
          <input
            id="profile-form-name"
            className={`${FORM_INPUT} font-mono tabular-nums`}
            value={values.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="staff-engineer"
            required
            disabled={busy}
          />
        </div>
      )}
      <div className="grid gap-1">
        <label htmlFor="profile-form-display" className={FORM_LABEL}>
          Display name
        </label>
        <input
          id="profile-form-display"
          className={FORM_INPUT}
          value={values.displayName}
          onChange={(event) => set("displayName", event.target.value)}
          placeholder="Staff Engineer"
          required
          disabled={busy}
        />
      </div>
      <fieldset className="space-y-1">
        <legend className={FORM_LABEL}>Work mode</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {WORK_MODES.map((mode) => (
            <label key={mode.value} className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={values.workMode.includes(mode.value)}
                disabled={busy}
                onChange={() => toggleWorkMode(mode.value)}
              />
              {mode.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-1">
        <label htmlFor="profile-form-auth" className={FORM_LABEL}>
          Work authorization (comma-separated)
        </label>
        <input
          id="profile-form-auth"
          className={FORM_INPUT}
          value={values.workAuthorization}
          onChange={(event) => set("workAuthorization", event.target.value)}
          placeholder="US citizen"
          disabled={busy}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1">
          <label htmlFor="profile-form-sponsor" className={FORM_LABEL}>
            Sponsorship required
          </label>
          <select
            id="profile-form-sponsor"
            className={FORM_INPUT}
            value={values.sponsorshipRequired ? "yes" : "no"}
            disabled={busy}
            onChange={(event) => set("sponsorshipRequired", event.target.value === "yes")}
          >
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </div>
        <div className="grid gap-1">
          <label htmlFor="profile-form-relocate" className={FORM_LABEL}>
            Willing to relocate
          </label>
          <select
            id="profile-form-relocate"
            className={FORM_INPUT}
            value={values.willingToRelocate ? "yes" : "no"}
            disabled={busy}
            onChange={(event) => set("willingToRelocate", event.target.value === "yes")}
          >
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </div>
      </div>
      <div className="grid gap-1">
        <label htmlFor="profile-form-yoe" className={FORM_LABEL}>
          Years of experience
        </label>
        <input
          id="profile-form-yoe"
          type="number"
          min={0}
          max={80}
          step="any"
          className={`${FORM_INPUT} tabular-nums`}
          value={values.yearsOfExperience}
          onChange={(event) => set("yearsOfExperience", event.target.value)}
          disabled={busy}
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="grid gap-1">
          <label htmlFor="profile-form-salary-min" className={FORM_LABEL}>
            Salary min
          </label>
          <input
            id="profile-form-salary-min"
            type="number"
            min={0}
            step="any"
            className={`${FORM_INPUT} tabular-nums`}
            value={values.salaryMin}
            onChange={(event) => set("salaryMin", event.target.value)}
            disabled={busy}
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor="profile-form-salary-target" className={FORM_LABEL}>
            Salary target
          </label>
          <input
            id="profile-form-salary-target"
            type="number"
            min={0}
            step="any"
            className={`${FORM_INPUT} tabular-nums`}
            value={values.salaryTarget}
            onChange={(event) => set("salaryTarget", event.target.value)}
            disabled={busy}
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor="profile-form-salary-currency" className={FORM_LABEL}>
            Currency
          </label>
          <input
            id="profile-form-salary-currency"
            className={`${FORM_INPUT} font-mono tabular-nums`}
            value={values.salaryCurrency}
            onChange={(event) => set("salaryCurrency", event.target.value)}
            placeholder="USD"
            disabled={busy}
          />
        </div>
      </div>
      <div className="grid gap-1">
        <label htmlFor="profile-form-narrative" className={FORM_LABEL}>
          Executive narrative
        </label>
        <textarea
          id="profile-form-narrative"
          rows={3}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          value={values.executiveNarrative}
          onChange={(event) => set("executiveNarrative", event.target.value)}
          disabled={busy}
        />
      </div>
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={busy}>
          {busy ? "Saving…" : profile === null ? "Create Profile" : "Save Changes"}
        </Button>
        <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
