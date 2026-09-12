import { z } from "zod";
import { evidenceQualifiedSkills } from "../tailoring/keywords";
import { isRecord, pyString, pyTruthy } from "../tailoring/primitives";
import { compareCodePoints } from "../tailoring/text";

/**
 * Canonical resume view model port (`services/documents/view_model.py`).
 *
 * Layout decisions live here and in the trusted template. Content selection
 * happens upstream; this module shapes validated content for presentation;
 * renderers only render. Every projection (plain text, Markdown, HTML/PDF,
 * DOCX) consumes this same model so section order, dates, contacts, and
 * claims cannot drift.
 *
 * Python semantics mirrored: `.get` defaults, truthiness, `str()` coercions
 * where the oracle applies them, stable descending experience sort
 * (current first, then end/start date descending — never company name),
 * and code-point string order. Two fail-closed divergences: non-record
 * profile/draft/claim inputs render as empty instead of raising
 * `AttributeError` like the oracle (an empty resume invents nothing).
 */

export const DEFAULT_MAX_DETAILED_ROLES = 3;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Port of `format_month_year`. */
export function formatMonthYear(value: unknown): string {
  const text = (pyTruthy(value) ? pyString(value) : "").trim();
  if (text.length >= 7 && text[4] === "-" && /^\d+$/.test(text.slice(0, 4))) {
    const raw = text.slice(5, 7).trim();
    if (/^[+-]?\d+$/.test(raw)) {
      const month = Number(raw);
      if (month >= 1 && month <= 12) {
        return `${MONTHS[month - 1] as string} ${Number(text.slice(0, 4))}`;
      }
    }
  }
  return text;
}

/** Port of `format_date_range`. */
export function formatDateRange(exp: Record<string, unknown>): string {
  const start = formatMonthYear(exp["start_date"]);
  const endRaw = exp["end_date"];
  let end: string;
  if (pyTruthy(endRaw)) {
    end = formatMonthYear(endRaw);
  } else if (pyTruthy(exp["is_current"])) {
    end = "Present";
  } else {
    end = "";
  }
  if (start !== "" && end !== "") {
    return `${start} - ${end}`;
  }
  return start !== "" ? start : end;
}

/** Port of `format_linkedin_display`. */
export function formatLinkedinDisplay(url: string): string {
  let text = url.trim();
  for (const prefix of ["https://", "http://"]) {
    if (text.toLowerCase().startsWith(prefix)) {
      text = text.slice(prefix.length);
    }
  }
  return text.replace(/\/+$/, "");
}

export interface ContactPart {
  text: string;
  href?: string;
}

/** Port of `build_contact_parts`. */
export function buildContactParts(profile: Record<string, unknown>): ContactPart[] {
  const parts: ContactPart[] = [];
  const location = pyString(profile["location"] ?? "").trim();
  if (location !== "") {
    parts.push({ text: location });
  }
  const phone = pyString(profile["phone"] ?? "").trim();
  if (phone !== "") {
    parts.push({ text: phone, href: `tel:${phone}` });
  }
  const email = pyString(profile["email"] ?? "").trim();
  if (email !== "") {
    parts.push({ text: email, href: `mailto:${email}` });
  }
  const prefs = isRecord(profile["preferences"]) ? profile["preferences"] : {};
  const linkedin = pyString(prefs["linkedin_url"] ?? "").trim();
  if (linkedin !== "") {
    parts.push({ text: formatLinkedinDisplay(linkedin), href: linkedin });
  }
  return parts;
}

/** Raw pass-through where the oracle keeps the value for the template. */
function asText(value: unknown, missing: string): string {
  if (value === undefined) {
    return missing;
  }
  return typeof value === "string" ? value : pyString(value);
}

/** Oracle `value or ""` idiom for optional display fields. */
function orEmpty(value: unknown): string {
  if (!pyTruthy(value)) {
    return "";
  }
  return typeof value === "string" ? value : pyString(value);
}

function compareExperiencesDesc(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const leftCurrent = pyTruthy(left["is_current"]) ? 1 : 0;
  const rightCurrent = pyTruthy(right["is_current"]) ? 1 : 0;
  if (leftCurrent !== rightCurrent) {
    return rightCurrent - leftCurrent;
  }
  const leftEnd = pyTruthy(left["end_date"]) ? pyString(left["end_date"]) : "";
  const rightEnd = pyTruthy(right["end_date"]) ? pyString(right["end_date"]) : "";
  if (leftEnd !== rightEnd) {
    return compareCodePoints(rightEnd, leftEnd);
  }
  const leftStart = pyTruthy(left["start_date"]) ? pyString(left["start_date"]) : "";
  const rightStart = pyTruthy(right["start_date"]) ? pyString(right["start_date"]) : "";
  if (leftStart !== rightStart) {
    return compareCodePoints(rightStart, leftStart);
  }
  return 0;
}

export const ContactPartSchema = z
  .object({ text: z.string(), href: z.string().optional() })
  .strict();
export const JobEntrySchema = z
  .object({
    company: z.string(),
    role: z.string(),
    location: z.string(),
    dates: z.string(),
    bullets: z.array(z.string()),
  })
  .strict();
export const SkillRowSchema = z.object({ label: z.string(), terms: z.array(z.string()) }).strict();
export const EducationRowSchema = z
  .object({ school: z.string(), detail: z.string(), dates: z.string() })
  .strict();
export const ResumeViewModel = z
  .object({
    header: z.object({ full_name: z.string(), contact_parts: z.array(ContactPartSchema) }).strict(),
    summary_copy: z.string(),
    professional_experience: z.array(JobEntrySchema),
    earlier_career: z.array(JobEntrySchema),
    skill_rows: z.array(SkillRowSchema),
    education_rows: z.array(EducationRowSchema),
  })
  .strict();
export type ResumeViewModel = z.infer<typeof ResumeViewModel>;
export type JobEntry = z.infer<typeof JobEntrySchema>;

const ViewModelEnvelope = z.object({
  profile: z.unknown(),
  draft: z.unknown(),
  maxDetailedRoles: z.number().int().optional(),
});

/** Port of `build_view_model`. */
export function buildViewModel(input: {
  profile: unknown;
  draft: unknown;
  maxDetailedRoles?: number;
}): ResumeViewModel {
  const envelope = ViewModelEnvelope.parse(input);
  const maxDetailedRoles = envelope.maxDetailedRoles ?? DEFAULT_MAX_DETAILED_ROLES;
  const profile = isRecord(envelope.profile) ? envelope.profile : {};
  const draft = isRecord(envelope.draft) ? envelope.draft : {};
  const rawClaims = draft["claims"];
  const allClaims: unknown[] = Array.isArray(rawClaims) ? rawClaims : [];
  const claims = allClaims.filter(isRecord);
  const summaryClaims = claims.filter((claim) => claim["section"] === "summary");
  const expClaims = claims.filter((claim) => claim["section"] === "experience");

  const summaryCopy =
    summaryClaims.length > 0 ? asText(summaryClaims[0]?.["text"], "") : "";

  const experiencesRaw = profile["work_experience"];
  const experiences = (Array.isArray(experiencesRaw) ? experiencesRaw : [])
    .filter(isRecord)
    .sort(compareExperiencesDesc);
  const bulletsByExp = new Map<string, string[]>();
  for (const claim of expClaims) {
    const eid = pyString("entity_id" in claim ? claim["entity_id"] : "");
    const text = pyString("text" in claim ? claim["text"] : "");
    if (eid !== "" && text !== "") {
      const list = bulletsByExp.get(eid) ?? [];
      list.push(text);
      bulletsByExp.set(eid, list);
    }
  }

  const jobEntry = (exp: Record<string, unknown>): JobEntry => ({
    company: asText("company" in exp ? exp["company"] : undefined, ""),
    role: asText("role" in exp ? exp["role"] : undefined, ""),
    location: orEmpty("location" in exp ? exp["location"] : undefined),
    dates: formatDateRange(exp),
    bullets: bulletsByExp.get(pyString(exp["id"])) ?? [],
  });

  const professionalExperience = experiences
    .slice(0, Math.max(0, maxDetailedRoles))
    .map(jobEntry)
    .filter((job) => job.bullets.length > 0);
  const earlierCareer = experiences
    .slice(Math.max(0, maxDetailedRoles))
    .map(jobEntry)
    .filter((job) => job.bullets.length > 0);

  const citedFactIds: string[] = [];
  for (const claim of claims) {
    const ids = claim["fact_ids"];
    const list = (Array.isArray(ids) ? ids : []) as unknown[];
    for (const fid of list) {
      if (typeof fid === "string") {
        citedFactIds.push(fid);
      }
    }
  }
  const qualified = evidenceQualifiedSkills({ profile, citedFactIds }).skills;
  const skillRows = qualified.length > 0 ? [{ label: "Core Competencies", terms: qualified }] : [];

  const educationRaw = profile["education"];
  const educationRows: Array<{ school: string; detail: string; dates: string }> = [];
  for (const raw of Array.isArray(educationRaw) ? educationRaw : []) {
    if (!isRecord(raw)) {
      continue;
    }
    const degree = orEmpty("degree" in raw ? raw["degree"] : undefined);
    const field = orEmpty("field_of_study" in raw ? raw["field_of_study"] : undefined);
    const institution = orEmpty("institution" in raw ? raw["institution"] : undefined);
    let detail = degree !== "" && field !== "" ? `${degree} in ${field}` : degree || field;
    if (institution !== "" && detail !== "") {
      detail = `${detail}, ${institution}`;
    } else if (institution !== "") {
      detail = institution;
    }
    const datesRaw = raw["graduation_date"];
    const fallbackRaw = raw["end_date"];
    const dates = orEmpty(pyTruthy(datesRaw) ? datesRaw : pyTruthy(fallbackRaw) ? fallbackRaw : "");
    educationRows.push({ school: institution, detail, dates });
  }

  return {
    header: {
      full_name: asText("full_name" in profile ? profile["full_name"] : undefined, "Candidate"),
      contact_parts: buildContactParts(profile),
    },
    summary_copy: summaryCopy,
    professional_experience: professionalExperience,
    earlier_career: earlierCareer,
    skill_rows: skillRows,
    education_rows: educationRows,
  };
}

/** Port of `render_plain_text` (same section order as HTML). */
export function renderPlainText(viewModel: ResumeViewModel): string {
  const lines: string[] = [];
  lines.push(viewModel.header.full_name.toUpperCase());
  lines.push(viewModel.header.contact_parts.map((part) => part.text).join(" | "));
  lines.push("-".repeat(60));

  if (viewModel.summary_copy !== "") {
    lines.push("SUMMARY");
    lines.push(viewModel.summary_copy);
    lines.push("");
  }

  if (viewModel.professional_experience.length > 0) {
    lines.push("PROFESSIONAL EXPERIENCE");
    for (const job of viewModel.professional_experience) {
      lines.push(`${job.company} | ${job.dates}`);
      lines.push(`${job.role} | ${job.location}`);
      for (const bullet of job.bullets) {
        lines.push(`  - ${bullet}`);
      }
      lines.push("");
    }
  }

  if (viewModel.earlier_career.length > 0) {
    lines.push("EARLIER CAREER");
    for (const job of viewModel.earlier_career) {
      lines.push(`${job.company} | ${job.dates}`);
      lines.push(`${job.role} | ${job.dates}`);
      for (const bullet of job.bullets) {
        lines.push(`  - ${bullet}`);
      }
      lines.push("");
    }
  }

  if (viewModel.skill_rows.length > 0) {
    lines.push("SKILLS");
    for (const row of viewModel.skill_rows) {
      lines.push(`${row.label}: ${row.terms.join(", ")}`);
    }
    lines.push("");
  }

  if (viewModel.education_rows.length > 0) {
    lines.push("EDUCATION");
    for (const edu of viewModel.education_rows) {
      const line = edu.dates !== "" ? `${edu.detail} (${edu.dates})` : edu.detail;
      lines.push(line);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export interface BaselineDraft {
  job_id: string;
  target_role: null;
  target_company: null;
  claims: Array<Record<string, unknown>>;
}

/** Port of `build_canonical_baseline_draft`. */
export function buildCanonicalBaselineDraft(profile: unknown): BaselineDraft {
  const record = isRecord(profile) ? profile : {};
  const factsRaw = record["verified_facts"];
  const facts = (Array.isArray(factsRaw) ? factsRaw : []).filter(
    (fact): fact is Record<string, unknown> =>
      isRecord(fact) && fact["verification_status"] === "approved",
  );
  const experiencesRaw = record["work_experience"];
  const experiences = (Array.isArray(experiencesRaw) ? experiencesRaw : []).filter(isRecord);
  experiences.sort((left, right) =>
    compareCodePoints(
      pyString(left["start_date"] ?? ""),
      pyString(right["start_date"] ?? ""),
    ),
  );
  const order = new Map<string, number>();
  experiences.forEach((exp, index) => {
    order.set(pyString(exp["id"]), index);
  });
  facts.sort((left, right) => {
    const leftWid = pyString(left["work_experience_id"]) || "";
    const rightWid = pyString(right["work_experience_id"]) || "";
    const leftOrder = order.get(leftWid) ?? 0;
    const rightOrder = order.get(rightWid) ?? 0;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return compareCodePoints(pyString(left["fact_id"]), pyString(right["fact_id"]));
  });

  const expById = new Map<string, Record<string, unknown>>();
  for (const exp of experiences) {
    expById.set(pyString(exp["id"]), exp);
  }

  const claims: Array<Record<string, unknown>> = [];
  let counter = 1;
  const claimId = (): string => {
    const id = `claim_${String(counter).padStart(3, "0")}`;
    counter += 1;
    return id;
  };
  const headline = pyString(record["headline"] ?? "").trim();
  if (headline !== "") {
    claims.push({
      claim_id: claimId(),
      section: "summary",
      text: headline,
      fact_ids: [],
      generation_strategy: "headline",
    });
  }
  for (const fact of facts) {
    const exp = expById.get(pyString(fact["work_experience_id"]) || "") ?? null;
    if (exp === null) {
      continue;
    }
    claims.push({
      claim_id: claimId(),
      section: "experience",
      entity_id: pyString(exp["id"]),
      company: "company" in exp ? exp["company"] : undefined,
      role: "role" in exp ? exp["role"] : undefined,
      dates: {
        start: pyString(exp["start_date"]),
        end: pyTruthy(exp["end_date"])
          ? pyString(exp["end_date"])
          : pyTruthy(exp["is_current"])
            ? "Present"
            : "",
      },
      text: "text" in fact ? fact["text"] : undefined,
      fact_ids: ["fact_id" in fact ? fact["fact_id"] : undefined],
      claimed_technologies: "technologies" in fact ? fact["technologies"] : [],
      claimed_metrics: "metrics" in fact ? fact["metrics"] : [],
      generation_strategy: "verbatim",
    });
  }
  const educationRaw = record["education"];
  for (const raw of Array.isArray(educationRaw) ? educationRaw : []) {
    if (!isRecord(raw)) {
      continue;
    }
    claims.push({
      claim_id: claimId(),
      section: "education",
      degree: "degree" in raw ? raw["degree"] : undefined,
      institution: "institution" in raw ? raw["institution"] : undefined,
      field_of_study: "field_of_study" in raw ? raw["field_of_study"] : undefined,
      text: `${pyString(raw["degree"])} in ${pyString(raw["field_of_study"])}, ${pyString(raw["institution"])}`,
      fact_ids: [],
      claimed_technologies: [],
      claimed_metrics: [],
      generation_strategy: "verbatim",
    });
  }
  return { job_id: "canonical-baseline", target_role: null, target_company: null, claims };
}
