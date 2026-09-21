"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { SettingsProfileSummary } from "./profiles";

export const FORM_INPUT = "h-8 rounded-md border border-input bg-background px-2 text-xs";
export const FORM_LABEL = "text-xs font-medium";

/** Every mutable steering field from the §2 inventory, as form strings. */
export interface PreferencesFormValues {
  displayName: string;
  workAuthorization: string;
  workMode: string[];
  sponsorshipRequired: "" | "no" | "yes";
  willingToRelocate: "" | "no" | "yes";
  yearsOfExperience: string;
  salaryMin: string;
  salaryTarget: string;
  salaryCurrency: string;
  salaryPeriod: "" | "HOURLY" | "MONTHLY" | "ANNUAL";
  targetTitles: string;
  targetLocations: string;
  careerKeywords: string;
  profileNotes: string;
  executiveNarrative: string;
}

export function preferencesFormDefaults(
  profile: SettingsProfileSummary,
): PreferencesFormValues {
  const prefs = profile.workPreferences;
  return {
    displayName: profile.displayName,
    workAuthorization: prefs === null ? "" : (prefs.workAuthorization ?? []).join(", "),
    workMode: prefs === null ? [] : [...(prefs.workMode ?? [])],
    sponsorshipRequired:
      prefs?.sponsorshipRequired === true ? "yes" : prefs?.sponsorshipRequired === false ? "no" : "",
    willingToRelocate:
      prefs?.willingToRelocate === true ? "yes" : prefs?.willingToRelocate === false ? "no" : "",
    yearsOfExperience:
      prefs?.yearsOfExperience === undefined ? "" : String(prefs.yearsOfExperience),
    salaryMin:
      prefs?.salaryExpectation?.min === undefined ? "" : String(prefs.salaryExpectation.min),
    salaryTarget:
      prefs?.salaryExpectation?.target === undefined
        ? ""
        : String(prefs.salaryExpectation.target),
    salaryCurrency: prefs?.salaryExpectation?.currency ?? "",
    salaryPeriod: prefs?.salaryExpectation?.period ?? "",
    targetTitles: prefs === null ? "" : (prefs.targetTitles ?? []).join("\n"),
    targetLocations: prefs === null ? "" : (prefs.targetLocations ?? []).join("\n"),
    careerKeywords: prefs === null ? "" : (prefs.careerKeywords ?? []).join("\n"),
    profileNotes: prefs?.profileNotes ?? "",
    executiveNarrative: profile.executiveNarrative ?? "",
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

function splitLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** PATCH/POST body fragment built from form values. */
export function preferencesFormInput(values: PreferencesFormValues): {
  displayName: string;
  workPreferences: Record<string, unknown>;
  executiveNarrative: string | null | undefined;
} {
  const yearsOfExperience = parseOptionalNumber(values.yearsOfExperience);
  const salaryMin = parseOptionalNumber(values.salaryMin);
  const salaryTarget = parseOptionalNumber(values.salaryTarget);
  const currency = values.salaryCurrency.trim();
  const salaryExpectation =
    salaryMin === undefined &&
    salaryTarget === undefined &&
    currency === "" &&
    values.salaryPeriod === ""
      ? undefined
      : {
          ...(salaryMin === undefined ? {} : { min: salaryMin }),
          ...(salaryTarget === undefined ? {} : { target: salaryTarget }),
          ...(currency === "" ? {} : { currency }),
          ...(values.salaryPeriod === "" ? {} : { period: values.salaryPeriod }),
        };
  return {
    displayName: values.displayName.trim(),
    workPreferences: {
      workAuthorization: values.workAuthorization
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
      workMode: values.workMode,
      sponsorshipRequired:
        values.sponsorshipRequired === "" ? null : values.sponsorshipRequired === "yes",
      willingToRelocate:
        values.willingToRelocate === "" ? null : values.willingToRelocate === "yes",
      targetTitles: splitLines(values.targetTitles),
      targetLocations: splitLines(values.targetLocations),
      careerKeywords: splitLines(values.careerKeywords),
      ...(values.profileNotes.trim() === "" ? {} : { profileNotes: values.profileNotes.trim() }),
      ...(yearsOfExperience === undefined ? {} : { yearsOfExperience }),
      ...(salaryExpectation === undefined ? {} : { salaryExpectation }),
    },
    executiveNarrative:
      values.executiveNarrative.trim() === "" ? null : values.executiveNarrative.trim(),
  };
}

const WORK_MODES = [
  { value: "REMOTE", label: "Remote" },
  { value: "HYBRID", label: "Hybrid" },
  { value: "ONSITE", label: "Onsite" },
] as const;

/**
 * Structured editor for one profile's mutable steering (C1): display
 * name, the full work-preference inventory including unknown
 * tri-states, and the executive narrative. Saving here never touches
 * master versions — review and activation are separate explicit
 * actions in the master workspace.
 */
export default function PreferencesForm({
  profile,
  disabled,
  submitLabel,
  onSubmit,
  onDirtyChange,
}: {
  profile: SettingsProfileSummary;
  disabled: boolean;
  submitLabel: string;
  onSubmit: (input: ReturnType<typeof preferencesFormInput>) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [initial] = useState<PreferencesFormValues>(() => preferencesFormDefaults(profile));
  const [values, setValues] = useState<PreferencesFormValues>(initial);

  function set<Key extends keyof PreferencesFormValues>(
    key: Key,
    value: PreferencesFormValues[Key],
  ): void {
    setValues((current) => {
      const next = { ...current, [key]: value };
      onDirtyChange?.(JSON.stringify(next) !== JSON.stringify(initial));
      return next;
    });
  }

  function toggleWorkMode(mode: string): void {
    setValues((current) => {
      const workMode = current.workMode.includes(mode)
        ? current.workMode.filter((entry) => entry !== mode)
        : [...current.workMode, mode];
      const next = { ...current, workMode };
      onDirtyChange?.(JSON.stringify(next) !== JSON.stringify(initial));
      return next;
    });
  }

  const prefix = `prefs-${profile.id}`;
  return (
    <form
      aria-label={`Preferences for ${profile.displayName}`}
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(preferencesFormInput(values));
      }}
    >
      <div className="grid gap-1">
        <label htmlFor={`${prefix}-display`} className={FORM_LABEL}>
          Display name
        </label>
        <input
          id={`${prefix}-display`}
          className={FORM_INPUT}
          value={values.displayName}
          onChange={(event) => set("displayName", event.target.value)}
          required
          disabled={disabled}
        />
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${prefix}-auth`} className={FORM_LABEL}>
          Work authorization (comma-separated)
        </label>
        <input
          id={`${prefix}-auth`}
          className={FORM_INPUT}
          value={values.workAuthorization}
          onChange={(event) => set("workAuthorization", event.target.value)}
          placeholder="US citizen"
          disabled={disabled}
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
                disabled={disabled}
                onChange={() => toggleWorkMode(mode.value)}
              />
              {mode.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1">
          <label htmlFor={`${prefix}-sponsor`} className={FORM_LABEL}>
            Sponsorship required
          </label>
          <select
            id={`${prefix}-sponsor`}
            className={FORM_INPUT}
            value={values.sponsorshipRequired}
            disabled={disabled}
            onChange={(event) =>
              set("sponsorshipRequired", event.target.value as PreferencesFormValues["sponsorshipRequired"])
            }
          >
            <option value="">Unknown</option>
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </div>
        <div className="grid gap-1">
          <label htmlFor={`${prefix}-relocate`} className={FORM_LABEL}>
            Willing to relocate
          </label>
          <select
            id={`${prefix}-relocate`}
            className={FORM_INPUT}
            value={values.willingToRelocate}
            disabled={disabled}
            onChange={(event) =>
              set("willingToRelocate", event.target.value as PreferencesFormValues["willingToRelocate"])
            }
          >
            <option value="">Unknown</option>
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </div>
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${prefix}-yoe`} className={FORM_LABEL}>
          Years of experience
        </label>
        <input
          id={`${prefix}-yoe`}
          type="number"
          min={0}
          max={80}
          step="any"
          className={`${FORM_INPUT} tabular-nums`}
          value={values.yearsOfExperience}
          onChange={(event) => set("yearsOfExperience", event.target.value)}
          disabled={disabled}
        />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="grid gap-1">
          <label htmlFor={`${prefix}-salary-min`} className={FORM_LABEL}>
            Salary min
          </label>
          <input
            id={`${prefix}-salary-min`}
            type="number"
            min={0}
            step="any"
            className={`${FORM_INPUT} tabular-nums`}
            value={values.salaryMin}
            onChange={(event) => set("salaryMin", event.target.value)}
            disabled={disabled}
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor={`${prefix}-salary-target`} className={FORM_LABEL}>
            Salary target
          </label>
          <input
            id={`${prefix}-salary-target`}
            type="number"
            min={0}
            step="any"
            className={`${FORM_INPUT} tabular-nums`}
            value={values.salaryTarget}
            onChange={(event) => set("salaryTarget", event.target.value)}
            disabled={disabled}
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor={`${prefix}-salary-currency`} className={FORM_LABEL}>
            Currency
          </label>
          <input
            id={`${prefix}-salary-currency`}
            className={`${FORM_INPUT} font-mono tabular-nums`}
            value={values.salaryCurrency}
            onChange={(event) => set("salaryCurrency", event.target.value)}
            placeholder="USD"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor={`${prefix}-salary-period`} className={FORM_LABEL}>
            Period
          </label>
          <select
            id={`${prefix}-salary-period`}
            className={FORM_INPUT}
            value={values.salaryPeriod}
            disabled={disabled}
            onChange={(event) =>
              set("salaryPeriod", event.target.value as PreferencesFormValues["salaryPeriod"])
            }
          >
            <option value="">Unspecified</option>
            <option value="HOURLY">Hourly</option>
            <option value="MONTHLY">Monthly</option>
            <option value="ANNUAL">Annual</option>
          </select>
        </div>
      </div>
      <div className="grid gap-1 sm:grid-cols-2 sm:gap-2">
        <div className="grid gap-1">
          <label htmlFor={`${prefix}-titles`} className={FORM_LABEL}>
            Target titles (one per line)
          </label>
          <textarea
            id={`${prefix}-titles`}
            rows={2}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            value={values.targetTitles}
            onChange={(event) => set("targetTitles", event.target.value)}
            disabled={disabled}
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor={`${prefix}-locations`} className={FORM_LABEL}>
            Target locations (one per line)
          </label>
          <textarea
            id={`${prefix}-locations`}
            rows={2}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            value={values.targetLocations}
            onChange={(event) => set("targetLocations", event.target.value)}
            disabled={disabled}
          />
        </div>
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${prefix}-keywords`} className={FORM_LABEL}>
          Career keywords (one per line)
        </label>
        <textarea
          id={`${prefix}-keywords`}
          rows={2}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          value={values.careerKeywords}
          onChange={(event) => set("careerKeywords", event.target.value)}
          disabled={disabled}
        />
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${prefix}-notes`} className={FORM_LABEL}>
          Profile notes
        </label>
        <textarea
          id={`${prefix}-notes`}
          rows={2}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          value={values.profileNotes}
          onChange={(event) => set("profileNotes", event.target.value)}
          disabled={disabled}
        />
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${prefix}-narrative`} className={FORM_LABEL}>
          Executive narrative
        </label>
        <textarea
          id={`${prefix}-narrative`}
          rows={3}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          value={values.executiveNarrative}
          onChange={(event) => set("executiveNarrative", event.target.value)}
          disabled={disabled}
        />
      </div>
      <div>
        <Button size="sm" type="submit" disabled={disabled}>
          {disabled ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
