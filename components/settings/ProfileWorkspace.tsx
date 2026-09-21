"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { apiGet, apiPatch, apiPost } from "../api";
import MasterOnboarding from "./MasterOnboarding";
import MasterPreview, { type PreviewPayload } from "./MasterPreview";
import PreferencesForm, { type preferencesFormInput } from "./PreferencesForm";
import {
  profileReadiness,
  type ProfileVersionEntry,
  type SettingsProfileSummary,
} from "./profiles";

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

/**
 * One profile's setup workspace (C1–C4, C6), independent of the
 * default: readiness with its precise next action, preference saving
 * (never touches masters), immutable master history with per-version
 * preview and JSON/Markdown exports plus explicit draft activation,
 * and master onboarding. Everything reads and writes B's persistence.
 */
export default function ProfileWorkspace({
  profile,
  busy,
  versionsTick,
  onRun,
  onProfilesChanged,
  onDirtyChange,
}: {
  profile: SettingsProfileSummary;
  busy: string | null;
  versionsTick: number;
  onRun: (action: string, fn: () => Promise<string>) => Promise<void>;
  onProfilesChanged: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [versions, setVersions] = useState<ProfileVersionEntry[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [prefsDirty, setPrefsDirty] = useState(false);
  const [onboardDirty, setOnboardDirty] = useState(false);
  const disabled = busy !== null;
  const readiness = profileReadiness(profile);

  function reportDirty(nextPrefs: boolean, nextOnboard: boolean): void {
    setPrefsDirty(nextPrefs);
    setOnboardDirty(nextOnboard);
    onDirtyChange?.(nextPrefs || nextOnboard);
  }

  // The parent remounts per profile id, so this effect only refetches
  // on versionsTick; prior rows stay visible until replaced (no flash).
  useEffect(() => {
    let cancelled = false;
    apiGet<{ versions: ProfileVersionEntry[] }>(
      `/api/settings/profiles/${profile.id}/versions`,
    ).then(
      (data) => {
        if (!cancelled) {
          setVersions(Array.isArray(data.versions) ? data.versions : []);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setVersionsError(error instanceof Error ? error.message : String(error));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [profile.id, versionsTick]);

  async function savePreferences(input: ReturnType<typeof preferencesFormInput>): Promise<void> {
    await onRun("profile-save", async () => {
      const updated = await apiPatch<{ profile: SettingsProfileSummary }>(
        `/api/settings/profiles/${profile.id}`,
        {
          displayName: input.displayName,
          workPreferences: input.workPreferences,
          executiveNarrative: input.executiveNarrative,
        },
      );
      reportDirty(false, onboardDirty);
      await onProfilesChanged();
      return `Preferences for “${updated.profile.displayName}” saved. Masters are untouched — review and activate separately.`;
    });
  }

  async function togglePreview(entry: ProfileVersionEntry): Promise<void> {
    if (previewId === entry.id) {
      setPreviewId(null);
      setPreview(null);
      setPreviewError(null);
      return;
    }
    setPreviewId(entry.id);
    setPreview(null);
    setPreviewError(null);
    try {
      const body = await apiGet<{ payload: PreviewPayload }>(
        `/api/settings/profiles/${profile.id}/versions/${entry.id}`,
      );
      setPreview(body.payload);
    } catch (error: unknown) {
      setPreviewError(error instanceof Error ? error.message : String(error));
    }
  }

  async function activateVersion(entry: ProfileVersionEntry): Promise<void> {
    await onRun("version-activate", async () => {
      const body = await apiPost<{
        ok: boolean;
        version: number;
        alreadyActive: boolean;
      }>(`/api/settings/profiles/${profile.id}/activate`, { versionId: entry.id });
      await onProfilesChanged();
      return body.alreadyActive
        ? `Version ${body.version} was already active.`
        : `Version ${body.version} of “${profile.displayName}” activated.`;
    });
  }

  return (
    <div className="space-y-5" aria-label={`Setup for ${profile.displayName}`}>
      <div
        className={cn(
          "rounded-md border p-3 text-xs",
          readiness.state === "ready" &&
            "border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-200 text-emerald-900",
          readiness.state === "staged" &&
            "border-amber-500/40 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-200 text-amber-900",
          readiness.state === "empty" &&
            "border-sky-500/40 bg-sky-50 dark:bg-sky-950/40 dark:text-sky-200 text-sky-900",
        )}
      >
        <p className="font-semibold">
          {readiness.state === "ready"
            ? "Ready for tailoring"
            : readiness.state === "staged"
              ? "Master staged — activation needed"
              : "Setup needed"}
          {profile.isDefault ? " · default profile" : ""}
        </p>
        <p className="mt-0.5">{readiness.detail}</p>
      </div>

      <section aria-label="Preferences" className="space-y-2">
        <h4 className="text-sm font-semibold">Preferences & narrative</h4>
        <PreferencesForm
          profile={profile}
          disabled={disabled}
          submitLabel={busy === "profile-save" ? "Saving…" : "Save preferences"}
          onSubmit={(input) => void savePreferences(input)}
          onDirtyChange={(dirty) => reportDirty(dirty, onboardDirty)}
        />
        <p className="text-[11px] text-muted-foreground">
          Saving preferences never activates a master — review and activation stay explicit below.
        </p>
      </section>

      <section aria-label="Master history" className="space-y-2">
        <h4 className="text-sm font-semibold">Master history</h4>
        {versionsError !== null && (
          <p role="alert" className="text-xs text-destructive">
            Could not load versions: {versionsError}
          </p>
        )}
        {versions === null && versionsError === null && (
          <p className="text-xs text-muted-foreground">Loading versions…</p>
        )}
        {versions !== null && versions.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No versions yet — onboard the first master below.
          </p>
        )}
        {versions !== null && versions.length > 0 && (
          <ul className="space-y-2">
            {versions.map((entry) => (
              <li key={entry.id} className="rounded-md border border-border px-3 py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p className="text-xs font-semibold">
                    v{entry.version}{" "}
                    <span
                      className={cn(
                        "ml-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                        entry.active
                          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                          : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
                      )}
                    >
                      {entry.active ? "Active" : "Draft"}
                    </span>
                  </p>
                  <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {entry.facts.total} facts · {entry.facts.approved} approved ·{" "}
                    {entry.source === null
                      ? "no recorded source"
                      : `${entry.source.origin} · ${formatBytes(entry.source.byteSize)}`}
                  </p>
                  <div className="ml-auto flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => void togglePreview(entry)}
                    >
                      {previewId === entry.id ? "Hide preview" : "Preview"}
                    </Button>
                    <a
                      href={`/api/settings/profiles/${profile.id}/versions/${entry.id}/export?format=json`}
                      download={`master-${profile.name}-v${entry.version}.json`}
                      className={cn(
                        "inline-flex h-8 items-center rounded-md px-3 text-xs font-medium hover:bg-muted",
                        disabled && "pointer-events-none opacity-50",
                      )}
                    >
                      JSON
                    </a>
                    <a
                      href={`/api/settings/profiles/${profile.id}/versions/${entry.id}/export?format=md`}
                      download={`master-${profile.name}-v${entry.version}.md`}
                      className={cn(
                        "inline-flex h-8 items-center rounded-md px-3 text-xs font-medium hover:bg-muted",
                        disabled && "pointer-events-none opacity-50",
                      )}
                    >
                      Markdown
                    </a>
                    {!entry.active && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={disabled}
                        onClick={() => void activateVersion(entry)}
                      >
                        {busy === "version-activate" ? "Activating…" : "Activate"}
                      </Button>
                    )}
                  </div>
                </div>
                {previewId === entry.id && (
                  <div className="mt-2 border-t border-border/40 pt-2">
                    {previewError !== null && (
                      <p role="alert" className="text-xs text-destructive">
                        Could not load preview: {previewError}
                      </p>
                    )}
                    {preview === null && previewError === null && (
                      <p className="text-xs text-muted-foreground">Loading preview…</p>
                    )}
                    {preview !== null && <MasterPreview payload={preview} />}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Onboard master" className="space-y-2">
        <h4 className="text-sm font-semibold">Onboard a new master</h4>
        <MasterOnboarding
          profile={profile}
          busy={busy}
          onRun={onRun}
          onChanged={onProfilesChanged}
          onDirtyChange={(dirty) => reportDirty(prefsDirty, dirty)}
        />
      </section>
    </div>
  );
}
