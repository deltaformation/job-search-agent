"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FORM_INPUT, FORM_LABEL } from "./PreferencesForm";
import { groupIssuesByPath, type MasterResumeIssue } from "./profiles";

/** Editable draft of one master document; ids are minted, never typed. */
export interface MasterDraft {
  identity: {
    fullName: string;
    headline: string;
    email: string;
    phone: string;
    location: string;
    linkedin: string;
    github: string;
    portfolio: string;
    website: string;
  };
  targetTitles: string;
  targetLocations: string;
  summary: string;
  employment: Array<{
    key: string;
    id: string;
    company: string;
    role: string;
    location: string;
    startDate: string;
    endDate: string;
    isCurrent: boolean;
    description: string;
  }>;
  achievements: Array<{
    key: string;
    factId: string;
    employmentKey: string;
    category: string;
    text: string;
    technologies: string;
    metrics: string;
    source: string;
  }>;
  skills: Array<{
    key: string;
    name: string;
    category: string;
    proficiency: "" | "beginner" | "proficient" | "expert";
    yearsExperience: string;
    verified: boolean;
  }>;
  languages: Array<{
    key: string;
    name: string;
    proficiency: "" | "beginner" | "proficient" | "expert";
    verified: boolean;
  }>;
  education: Array<{
    key: string;
    degree: string;
    fieldOfStudy: string;
    institution: string;
    startDate: string;
    endDate: string;
  }>;
  credentials: Array<{
    key: string;
    name: string;
    issuer: string;
    issuedDate: string;
    credentialId: string;
  }>;
}

export function emptyMasterDraft(): MasterDraft {
  return {
    identity: {
      fullName: "",
      headline: "",
      email: "",
      phone: "",
      location: "",
      linkedin: "",
      github: "",
      portfolio: "",
      website: "",
    },
    targetTitles: "",
    targetLocations: "",
    summary: "",
    employment: [],
    achievements: [],
    skills: [],
    languages: [],
    education: [],
    credentials: [],
  };
}

function optionalText(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function splitLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function splitCommas(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Assemble an import-v2 document from the draft. Empty optionals are
 * omitted (never sent as empty strings); achievements stay
 * `PENDING` — review, not data entry, approves claims.
 */
export function assembleMasterDocument(draft: MasterDraft): Record<string, unknown> {
  const employmentByKey = new Map(draft.employment.map((job) => [job.key, job.id]));
  const links = {
    ...(optionalText(draft.identity.linkedin) === undefined
      ? {}
      : { linkedin: draft.identity.linkedin.trim() }),
    ...(optionalText(draft.identity.github) === undefined
      ? {}
      : { github: draft.identity.github.trim() }),
    ...(optionalText(draft.identity.portfolio) === undefined
      ? {}
      : { portfolio: draft.identity.portfolio.trim() }),
    ...(optionalText(draft.identity.website) === undefined
      ? {}
      : { website: draft.identity.website.trim() }),
  };
  return {
    schemaVersion: "candidate-import/v2",
    identity: {
      fullName: draft.identity.fullName.trim(),
      ...(optionalText(draft.identity.headline) === undefined
        ? {}
        : { headline: draft.identity.headline.trim() }),
      ...(optionalText(draft.identity.email) === undefined
        ? {}
        : { email: draft.identity.email.trim() }),
      ...(optionalText(draft.identity.phone) === undefined
        ? {}
        : { phone: draft.identity.phone.trim() }),
      ...(optionalText(draft.identity.location) === undefined
        ? {}
        : { location: draft.identity.location.trim() }),
      ...(Object.keys(links).length === 0 ? {} : { links }),
    },
    targetTitles: splitLines(draft.targetTitles),
    targetLocations: splitLines(draft.targetLocations),
    ...(optionalText(draft.summary) === undefined ? {} : { summary: draft.summary.trim() }),
    employment: draft.employment.map((job) => ({
      id: job.id,
      company: job.company.trim(),
      role: job.role.trim(),
      ...(optionalText(job.location) === undefined ? {} : { location: job.location.trim() }),
      startDate: job.startDate.trim(),
      ...(!job.isCurrent && optionalText(job.endDate) !== undefined
        ? { endDate: job.endDate.trim() }
        : {}),
      isCurrent: job.isCurrent,
      ...(optionalText(job.description) === undefined
        ? {}
        : { description: job.description.trim() }),
    })),
    achievements: draft.achievements.map((achievement) => ({
      factId: achievement.factId,
      ...(achievement.employmentKey === "" ||
      employmentByKey.get(achievement.employmentKey) === undefined
        ? {}
        : { employmentId: employmentByKey.get(achievement.employmentKey) }),
      category: achievement.category.trim(),
      text: achievement.text.trim(),
      technologies: splitCommas(achievement.technologies),
      metrics: splitLines(achievement.metrics),
      ...(optionalText(achievement.source) === undefined
        ? {}
        : { source: achievement.source.trim() }),
      verification: "PENDING",
    })),
    skills: draft.skills.map((skill) => {
      const years = skill.yearsExperience.trim();
      return {
        name: skill.name.trim(),
        ...(optionalText(skill.category) === undefined ? {} : { category: skill.category.trim() }),
        ...(skill.proficiency === "" ? {} : { proficiency: skill.proficiency }),
        ...(years === "" || !Number.isFinite(Number(years)) ? {} : { yearsExperience: Number(years) }),
        verified: skill.verified,
      };
    }),
    languages: draft.languages.map((language) => ({
      name: language.name.trim(),
      ...(language.proficiency === "" ? {} : { proficiency: language.proficiency }),
      verified: language.verified,
    })),
    education: draft.education.map((entry) => ({
      degree: entry.degree.trim(),
      ...(optionalText(entry.fieldOfStudy) === undefined
        ? {}
        : { fieldOfStudy: entry.fieldOfStudy.trim() }),
      institution: entry.institution.trim(),
      ...(optionalText(entry.startDate) === undefined ? {} : { startDate: entry.startDate.trim() }),
      ...(optionalText(entry.endDate) === undefined ? {} : { endDate: entry.endDate.trim() }),
    })),
    credentials: draft.credentials.map((entry) => ({
      name: entry.name.trim(),
      ...(optionalText(entry.issuer) === undefined ? {} : { issuer: entry.issuer.trim() }),
      ...(optionalText(entry.issuedDate) === undefined
        ? {}
        : { issuedDate: entry.issuedDate.trim() }),
      ...(optionalText(entry.credentialId) === undefined
        ? {}
        : { credentialId: entry.credentialId.trim() }),
    })),
  };
}

function FieldError({ id, messages }: { id: string; messages: MasterResumeIssue[] }) {
  if (messages.length === 0) {
    return null;
  }
  return (
    <p id={id} role="alert" className="text-[11px] font-medium text-destructive">
      {messages.map((issue) => issue.message).join(" ")}
    </p>
  );
}

function TextField({
  id,
  label,
  value,
  disabled,
  issues,
  placeholder,
  mono,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  issues: MasterResumeIssue[];
  placeholder?: string;
  mono?: boolean;
  onChange: (value: string) => void;
}) {
  const errorId = `${id}-error`;
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className={FORM_LABEL}>
        {label}
      </label>
      <input
        id={id}
        className={cn(FORM_INPUT, mono === true && "font-mono tabular-nums")}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={issues.length > 0}
        aria-describedby={issues.length > 0 ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldError id={errorId} messages={issues} />
    </div>
  );
}

/**
 * Structured master-document editor (C1): labeled controls for every
 * §2 payload field. Employment ids and fact ids are minted by the
 * form — ordinary entry never requires hand-authored ids — and new
 * achievements always enter as `PENDING`. Server issues highlight
 * their exact control; the draft survives validation failures and
 * background refreshes because it lives in local state.
 */
export default function MasterDocumentForm({
  idPrefix,
  disabled,
  issues,
  submitLabel,
  onSubmitDocument,
  onDirtyChange,
}: {
  idPrefix: string;
  disabled: boolean;
  issues: MasterResumeIssue[];
  submitLabel: string;
  onSubmitDocument: (document: Record<string, unknown>) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [initial] = useState<MasterDraft>(emptyMasterDraft);
  const [draft, setDraft] = useState<MasterDraft>(initial);
  const counter = useRef(0);
  const grouped = groupIssuesByPath(issues);

  function update(rewrite: (current: MasterDraft) => MasterDraft): void {
    setDraft((current) => {
      const next = rewrite(current);
      onDirtyChange?.(JSON.stringify(next) !== JSON.stringify(initial));
      return next;
    });
  }

  function mint(prefix: string): string {
    counter.current += 1;
    return `${prefix}-${counter.current}`;
  }

  function at(path: string): MasterResumeIssue[] {
    return grouped.get(path) ?? [];
  }

  function updateIdentity<Key extends keyof MasterDraft["identity"]>(
    key: Key,
    value: string,
  ): void {
    update((current) => ({ ...current, identity: { ...current.identity, [key]: value } }));
  }

  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold">Identity & contact</legend>
        <TextField
          id={`${idPrefix}-fullname`}
          label="Full name"
          value={draft.identity.fullName}
          disabled={disabled}
          issues={at("identity.fullName")}
          onChange={(value) => updateIdentity("fullName", value)}
        />
        <TextField
          id={`${idPrefix}-headline`}
          label="Headline"
          value={draft.identity.headline}
          disabled={disabled}
          issues={at("identity.headline")}
          onChange={(value) => updateIdentity("headline", value)}
        />
        <div className="grid gap-2 sm:grid-cols-3">
          <TextField
            id={`${idPrefix}-email`}
            label="Email"
            value={draft.identity.email}
            disabled={disabled}
            issues={at("identity.email")}
            onChange={(value) => updateIdentity("email", value)}
          />
          <TextField
            id={`${idPrefix}-phone`}
            label="Phone"
            value={draft.identity.phone}
            disabled={disabled}
            issues={at("identity.phone")}
            onChange={(value) => updateIdentity("phone", value)}
          />
          <TextField
            id={`${idPrefix}-location`}
            label="Location"
            value={draft.identity.location}
            disabled={disabled}
            issues={at("identity.location")}
            onChange={(value) => updateIdentity("location", value)}
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <TextField
            id={`${idPrefix}-linkedin`}
            label="LinkedIn"
            value={draft.identity.linkedin}
            disabled={disabled}
            issues={at("identity.links.linkedin")}
            mono
            onChange={(value) => updateIdentity("linkedin", value)}
          />
          <TextField
            id={`${idPrefix}-github`}
            label="GitHub"
            value={draft.identity.github}
            disabled={disabled}
            issues={at("identity.links.github")}
            mono
            onChange={(value) => updateIdentity("github", value)}
          />
          <TextField
            id={`${idPrefix}-portfolio`}
            label="Portfolio"
            value={draft.identity.portfolio}
            disabled={disabled}
            issues={at("identity.links.portfolio")}
            mono
            onChange={(value) => updateIdentity("portfolio", value)}
          />
          <TextField
            id={`${idPrefix}-website`}
            label="Website"
            value={draft.identity.website}
            disabled={disabled}
            issues={at("identity.links.website")}
            mono
            onChange={(value) => updateIdentity("website", value)}
          />
        </div>
      </fieldset>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-1">
          <label htmlFor={`${idPrefix}-titles`} className={FORM_LABEL}>
            Target titles (one per line)
          </label>
          <textarea
            id={`${idPrefix}-titles`}
            rows={2}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            value={draft.targetTitles}
            disabled={disabled}
            aria-invalid={at("targetTitles").length > 0}
            onChange={(event) =>
              update((current) => ({ ...current, targetTitles: event.target.value }))
            }
          />
          <FieldError id={`${idPrefix}-titles-error`} messages={at("targetTitles")} />
        </div>
        <div className="grid gap-1">
          <label htmlFor={`${idPrefix}-target-locations`} className={FORM_LABEL}>
            Target locations (one per line)
          </label>
          <textarea
            id={`${idPrefix}-target-locations`}
            rows={2}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            value={draft.targetLocations}
            disabled={disabled}
            aria-invalid={at("targetLocations").length > 0}
            onChange={(event) =>
              update((current) => ({ ...current, targetLocations: event.target.value }))
            }
          />
          <FieldError id={`${idPrefix}-target-locations-error`} messages={at("targetLocations")} />
        </div>
      </div>

      <div className="grid gap-1">
        <label htmlFor={`${idPrefix}-summary`} className={FORM_LABEL}>
          Summary
        </label>
        <textarea
          id={`${idPrefix}-summary`}
          rows={3}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          value={draft.summary}
          disabled={disabled}
          aria-invalid={at("summary").length > 0}
          onChange={(event) => update((current) => ({ ...current, summary: event.target.value }))}
        />
        <FieldError id={`${idPrefix}-summary-error`} messages={at("summary")} />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold">
          Employment ({draft.employment.length})
        </legend>
        {draft.employment.map((job, index) => (
          <div key={job.key} className="space-y-2 rounded-md border border-border/60 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {job.id}
              </p>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={disabled}
                onClick={() =>
                  update((current) => ({
                    ...current,
                    employment: current.employment.filter((entry) => entry.key !== job.key),
                    achievements: current.achievements.map((entry) =>
                      entry.employmentKey === job.key ? { ...entry, employmentKey: "" } : entry,
                    ),
                  }))
                }
              >
                Remove
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <TextField
                id={`${idPrefix}-emp-${index}-company`}
                label="Company"
                value={job.company}
                disabled={disabled}
                issues={at(`employment.${index}.company`)}
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    employment: current.employment.map((entry) =>
                      entry.key === job.key ? { ...entry, company: value } : entry,
                    ),
                  }))
                }
              />
              <TextField
                id={`${idPrefix}-emp-${index}-role`}
                label="Role"
                value={job.role}
                disabled={disabled}
                issues={at(`employment.${index}.role`)}
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    employment: current.employment.map((entry) =>
                      entry.key === job.key ? { ...entry, role: value } : entry,
                    ),
                  }))
                }
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <TextField
                id={`${idPrefix}-emp-${index}-location`}
                label="Location"
                value={job.location}
                disabled={disabled}
                issues={at(`employment.${index}.location`)}
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    employment: current.employment.map((entry) =>
                      entry.key === job.key ? { ...entry, location: value } : entry,
                    ),
                  }))
                }
              />
              <TextField
                id={`${idPrefix}-emp-${index}-start`}
                label="Start date (YYYY-MM-DD)"
                value={job.startDate}
                disabled={disabled}
                issues={at(`employment.${index}.startDate`)}
                mono
                placeholder="2021-03-01"
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    employment: current.employment.map((entry) =>
                      entry.key === job.key ? { ...entry, startDate: value } : entry,
                    ),
                  }))
                }
              />
              <TextField
                id={`${idPrefix}-emp-${index}-end`}
                label="End date (YYYY-MM-DD)"
                value={job.endDate}
                disabled={job.isCurrent || disabled}
                issues={at(`employment.${index}.endDate`)}
                mono
                placeholder="2023-06-30"
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    employment: current.employment.map((entry) =>
                      entry.key === job.key ? { ...entry, endDate: value } : entry,
                    ),
                  }))
                }
              />
            </div>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={job.isCurrent}
                disabled={disabled}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    employment: current.employment.map((entry) =>
                      entry.key === job.key
                        ? { ...entry, isCurrent: event.target.checked }
                        : entry,
                    ),
                  }))
                }
              />
              Current role
            </label>
            <div className="grid gap-1">
              <label htmlFor={`${idPrefix}-emp-${index}-description`} className={FORM_LABEL}>
                Description
              </label>
              <textarea
                id={`${idPrefix}-emp-${index}-description`}
                rows={2}
                className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                value={job.description}
                disabled={disabled}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    employment: current.employment.map((entry) =>
                      entry.key === job.key ? { ...entry, description: event.target.value } : entry,
                    ),
                  }))
                }
              />
              <FieldError
                id={`${idPrefix}-emp-${index}-description-error`}
                messages={at(`employment.${index}.description`)}
              />
            </div>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={disabled}
            onClick={() => {
              const key = mint("row");
              update((current) => ({
                ...current,
                employment: [
                  ...current.employment,
                  {
                    key,
                    id: mint("emp"),
                    company: "",
                    role: "",
                    location: "",
                    startDate: "",
                    endDate: "",
                    isCurrent: false,
                    description: "",
                  },
                ],
              }));
            }}
          >
            Add employment
          </Button>
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold">
          Achievements ({draft.achievements.length})
        </legend>
        <p className="text-[11px] text-muted-foreground">
          New achievements enter as pending review; fact ids are minted automatically.
        </p>
        {draft.achievements.map((achievement, index) => (
          <div
            key={achievement.key}
            className="space-y-2 rounded-md border border-border/60 p-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {achievement.factId} · pending review
              </p>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={disabled}
                onClick={() =>
                  update((current) => ({
                    ...current,
                    achievements: current.achievements.filter(
                      (entry) => entry.key !== achievement.key,
                    ),
                  }))
                }
              >
                Remove
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-1">
                <label htmlFor={`${idPrefix}-ach-${index}-employment`} className={FORM_LABEL}>
                  Employment
                </label>
                <select
                  id={`${idPrefix}-ach-${index}-employment`}
                  className={FORM_INPUT}
                  value={achievement.employmentKey}
                  disabled={disabled}
                  onChange={(event) =>
                    update((current) => ({
                      ...current,
                      achievements: current.achievements.map((entry) =>
                        entry.key === achievement.key
                          ? { ...entry, employmentKey: event.target.value }
                          : entry,
                      ),
                    }))
                  }
                >
                  <option value="">Unassigned</option>
                  {draft.employment.map((job) => (
                    <option key={job.key} value={job.key}>
                      {job.company === "" && job.role === "" ? job.id : `${job.role} · ${job.company}`}
                    </option>
                  ))}
                </select>
              </div>
              <TextField
                id={`${idPrefix}-ach-${index}-category`}
                label="Category"
                value={achievement.category}
                disabled={disabled}
                issues={at(`achievements.${index}.category`)}
                placeholder="launch"
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    achievements: current.achievements.map((entry) =>
                      entry.key === achievement.key ? { ...entry, category: value } : entry,
                    ),
                  }))
                }
              />
            </div>
            <div className="grid gap-1">
              <label htmlFor={`${idPrefix}-ach-${index}-text`} className={FORM_LABEL}>
                Achievement text
              </label>
              <textarea
                id={`${idPrefix}-ach-${index}-text`}
                rows={2}
                className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                value={achievement.text}
                disabled={disabled}
                aria-invalid={at(`achievements.${index}.text`).length > 0}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    achievements: current.achievements.map((entry) =>
                      entry.key === achievement.key ? { ...entry, text: event.target.value } : entry,
                    ),
                  }))
                }
              />
              <FieldError
                id={`${idPrefix}-ach-${index}-text-error`}
                messages={at(`achievements.${index}.text`)}
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <TextField
                id={`${idPrefix}-ach-${index}-tech`}
                label="Technologies (comma-separated)"
                value={achievement.technologies}
                disabled={disabled}
                issues={at(`achievements.${index}.technologies`)}
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    achievements: current.achievements.map((entry) =>
                      entry.key === achievement.key ? { ...entry, technologies: value } : entry,
                    ),
                  }))
                }
              />
              <TextField
                id={`${idPrefix}-ach-${index}-source`}
                label="Source"
                value={achievement.source}
                disabled={disabled}
                issues={at(`achievements.${index}.source`)}
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    achievements: current.achievements.map((entry) =>
                      entry.key === achievement.key ? { ...entry, source: value } : entry,
                    ),
                  }))
                }
              />
            </div>
            <div className="grid gap-1">
              <label htmlFor={`${idPrefix}-ach-${index}-metrics`} className={FORM_LABEL}>
                Metrics (one per line)
              </label>
              <textarea
                id={`${idPrefix}-ach-${index}-metrics`}
                rows={2}
                className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                value={achievement.metrics}
                disabled={disabled}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    achievements: current.achievements.map((entry) =>
                      entry.key === achievement.key
                        ? { ...entry, metrics: event.target.value }
                        : entry,
                    ),
                  }))
                }
              />
              <FieldError
                id={`${idPrefix}-ach-${index}-metrics-error`}
                messages={at(`achievements.${index}.metrics`)}
              />
            </div>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={disabled}
            onClick={() => {
              const key = mint("row");
              update((current) => ({
                ...current,
                achievements: [
                  ...current.achievements,
                  {
                    key,
                    factId: mint("fact"),
                    employmentKey: "",
                    category: "",
                    text: "",
                    technologies: "",
                    metrics: "",
                    source: "",
                  },
                ],
              }));
            }}
          >
            Add achievement
          </Button>
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold">Skills ({draft.skills.length})</legend>
        {draft.skills.map((skill, index) => (
          <div key={skill.key} className="space-y-2 rounded-md border border-border/60 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium">Skill {index + 1}</p>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={disabled}
                onClick={() =>
                  update((current) => ({
                    ...current,
                    skills: current.skills.filter((entry) => entry.key !== skill.key),
                  }))
                }
              >
                Remove
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <TextField
                id={`${idPrefix}-skill-${index}-name`}
                label="Name"
                value={skill.name}
                disabled={disabled}
                issues={at(`skills.${index}.name`)}
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    skills: current.skills.map((entry) =>
                      entry.key === skill.key ? { ...entry, name: value } : entry,
                    ),
                  }))
                }
              />
              <TextField
                id={`${idPrefix}-skill-${index}-category`}
                label="Category"
                value={skill.category}
                disabled={disabled}
                issues={at(`skills.${index}.category`)}
                placeholder="technical"
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    skills: current.skills.map((entry) =>
                      entry.key === skill.key ? { ...entry, category: value } : entry,
                    ),
                  }))
                }
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="grid gap-1">
                <label htmlFor={`${idPrefix}-skill-${index}-proficiency`} className={FORM_LABEL}>
                  Proficiency
                </label>
                <select
                  id={`${idPrefix}-skill-${index}-proficiency`}
                  className={FORM_INPUT}
                  value={skill.proficiency}
                  disabled={disabled}
                  onChange={(event) =>
                    update((current) => ({
                      ...current,
                      skills: current.skills.map((entry) =>
                        entry.key === skill.key
                          ? {
                              ...entry,
                              proficiency: event.target.value as MasterDraft["skills"][number]["proficiency"],
                            }
                          : entry,
                      ),
                    }))
                  }
                >
                  <option value="">Unspecified</option>
                  <option value="beginner">Beginner</option>
                  <option value="proficient">Proficient</option>
                  <option value="expert">Expert</option>
                </select>
              </div>
              <TextField
                id={`${idPrefix}-skill-${index}-yoe`}
                label="Years"
                value={skill.yearsExperience}
                disabled={disabled}
                issues={at(`skills.${index}.yearsExperience`)}
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    skills: current.skills.map((entry) =>
                      entry.key === skill.key ? { ...entry, yearsExperience: value } : entry,
                    ),
                  }))
                }
              />
              <label className="flex items-center gap-1.5 self-end pb-2 text-xs">
                <input
                  type="checkbox"
                  checked={skill.verified}
                  disabled={disabled}
                  onChange={(event) =>
                    update((current) => ({
                      ...current,
                      skills: current.skills.map((entry) =>
                        entry.key === skill.key
                          ? { ...entry, verified: event.target.checked }
                          : entry,
                      ),
                    }))
                  }
                />
                Verified
              </label>
            </div>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={disabled}
            onClick={() => {
              update((current) => ({
                ...current,
                skills: [
                  ...current.skills,
                  {
                    key: mint("row"),
                    name: "",
                    category: "",
                    proficiency: "",
                    yearsExperience: "",
                    verified: false,
                  },
                ],
              }));
            }}
          >
            Add skill
          </Button>
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold">Languages ({draft.languages.length})</legend>
        {draft.languages.map((language, index) => (
          <div
            key={language.key}
            className="space-y-2 rounded-md border border-border/60 p-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium">Language {index + 1}</p>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={disabled}
                onClick={() =>
                  update((current) => ({
                    ...current,
                    languages: current.languages.filter((entry) => entry.key !== language.key),
                  }))
                }
              >
                Remove
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <TextField
                id={`${idPrefix}-lang-${index}-name`}
                label="Name"
                value={language.name}
                disabled={disabled}
                issues={at(`languages.${index}.name`)}
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    languages: current.languages.map((entry) =>
                      entry.key === language.key ? { ...entry, name: value } : entry,
                    ),
                  }))
                }
              />
              <div className="grid gap-1">
                <label htmlFor={`${idPrefix}-lang-${index}-proficiency`} className={FORM_LABEL}>
                  Proficiency
                </label>
                <select
                  id={`${idPrefix}-lang-${index}-proficiency`}
                  className={FORM_INPUT}
                  value={language.proficiency}
                  disabled={disabled}
                  onChange={(event) =>
                    update((current) => ({
                      ...current,
                      languages: current.languages.map((entry) =>
                        entry.key === language.key
                          ? {
                              ...entry,
                              proficiency: event.target.value as MasterDraft["languages"][number]["proficiency"],
                            }
                          : entry,
                      ),
                    }))
                  }
                >
                  <option value="">Unspecified</option>
                  <option value="beginner">Beginner</option>
                  <option value="proficient">Proficient</option>
                  <option value="expert">Expert</option>
                </select>
              </div>
              <label className="flex items-center gap-1.5 self-end pb-2 text-xs">
                <input
                  type="checkbox"
                  checked={language.verified}
                  disabled={disabled}
                  onChange={(event) =>
                    update((current) => ({
                      ...current,
                      languages: current.languages.map((entry) =>
                        entry.key === language.key
                          ? { ...entry, verified: event.target.checked }
                          : entry,
                      ),
                    }))
                  }
                />
                Verified
              </label>
            </div>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={disabled}
            onClick={() => {
              update((current) => ({
                ...current,
                languages: [
                  ...current.languages,
                  { key: mint("row"), name: "", proficiency: "", verified: false },
                ],
              }));
            }}
          >
            Add language
          </Button>
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold">Education ({draft.education.length})</legend>
        {draft.education.map((entry, index) => (
          <div key={entry.key} className="space-y-2 rounded-md border border-border/60 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium">Education {index + 1}</p>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={disabled}
                onClick={() =>
                  update((current) => ({
                    ...current,
                    education: current.education.filter((row) => row.key !== entry.key),
                  }))
                }
              >
                Remove
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <TextField
                id={`${idPrefix}-edu-${index}-degree`}
                label="Degree"
                value={entry.degree}
                disabled={disabled}
                issues={at(`education.${index}.degree`)}
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    education: current.education.map((row) =>
                      row.key === entry.key ? { ...row, degree: value } : row,
                    ),
                  }))
                }
              />
              <TextField
                id={`${idPrefix}-edu-${index}-field`}
                label="Field of study"
                value={entry.fieldOfStudy}
                disabled={disabled}
                issues={at(`education.${index}.fieldOfStudy`)}
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    education: current.education.map((row) =>
                      row.key === entry.key ? { ...row, fieldOfStudy: value } : row,
                    ),
                  }))
                }
              />
            </div>
            <TextField
              id={`${idPrefix}-edu-${index}-institution`}
              label="Institution"
              value={entry.institution}
              disabled={disabled}
              issues={at(`education.${index}.institution`)}
              onChange={(value) =>
                update((current) => ({
                  ...current,
                  education: current.education.map((row) =>
                    row.key === entry.key ? { ...row, institution: value } : row,
                  ),
                }))
              }
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <TextField
                id={`${idPrefix}-edu-${index}-start`}
                label="Start date (YYYY-MM-DD)"
                value={entry.startDate}
                disabled={disabled}
                issues={at(`education.${index}.startDate`)}
                mono
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    education: current.education.map((row) =>
                      row.key === entry.key ? { ...row, startDate: value } : row,
                    ),
                  }))
                }
              />
              <TextField
                id={`${idPrefix}-edu-${index}-end`}
                label="End date (YYYY-MM-DD)"
                value={entry.endDate}
                disabled={disabled}
                issues={at(`education.${index}.endDate`)}
                mono
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    education: current.education.map((row) =>
                      row.key === entry.key ? { ...row, endDate: value } : row,
                    ),
                  }))
                }
              />
            </div>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={disabled}
            onClick={() => {
              update((current) => ({
                ...current,
                education: [
                  ...current.education,
                  {
                    key: mint("row"),
                    degree: "",
                    fieldOfStudy: "",
                    institution: "",
                    startDate: "",
                    endDate: "",
                  },
                ],
              }));
            }}
          >
            Add education
          </Button>
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold">
          Credentials ({draft.credentials.length})
        </legend>
        {draft.credentials.map((entry, index) => (
          <div key={entry.key} className="space-y-2 rounded-md border border-border/60 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium">Credential {index + 1}</p>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={disabled}
                onClick={() =>
                  update((current) => ({
                    ...current,
                    credentials: current.credentials.filter((row) => row.key !== entry.key),
                  }))
                }
              >
                Remove
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <TextField
                id={`${idPrefix}-cred-${index}-name`}
                label="Name"
                value={entry.name}
                disabled={disabled}
                issues={at(`credentials.${index}.name`)}
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    credentials: current.credentials.map((row) =>
                      row.key === entry.key ? { ...row, name: value } : row,
                    ),
                  }))
                }
              />
              <TextField
                id={`${idPrefix}-cred-${index}-issuer`}
                label="Issuer"
                value={entry.issuer}
                disabled={disabled}
                issues={at(`credentials.${index}.issuer`)}
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    credentials: current.credentials.map((row) =>
                      row.key === entry.key ? { ...row, issuer: value } : row,
                    ),
                  }))
                }
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <TextField
                id={`${idPrefix}-cred-${index}-issued`}
                label="Issued date (YYYY-MM-DD)"
                value={entry.issuedDate}
                disabled={disabled}
                issues={at(`credentials.${index}.issuedDate`)}
                mono
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    credentials: current.credentials.map((row) =>
                      row.key === entry.key ? { ...row, issuedDate: value } : row,
                    ),
                  }))
                }
              />
              <TextField
                id={`${idPrefix}-cred-${index}-id`}
                label="Credential id"
                value={entry.credentialId}
                disabled={disabled}
                issues={at(`credentials.${index}.credentialId`)}
                mono
                onChange={(value) =>
                  update((current) => ({
                    ...current,
                    credentials: current.credentials.map((row) =>
                      row.key === entry.key ? { ...row, credentialId: value } : row,
                    ),
                  }))
                }
              />
            </div>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={disabled}
            onClick={() => {
              update((current) => ({
                ...current,
                credentials: [
                  ...current.credentials,
                  { key: mint("row"), name: "", issuer: "", issuedDate: "", credentialId: "" },
                ],
              }));
            }}
          >
            Add credential
          </Button>
        </div>
      </fieldset>

      <div>
        <Button
          size="sm"
          type="button"
          disabled={disabled}
          onClick={() => onSubmitDocument(assembleMasterDocument(draft))}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
