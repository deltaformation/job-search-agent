import type { JobEntry, ResumeViewModel } from "./viewModel";

/**
 * Markdown projection of the canonical view model (new renderer; the
 * oracle produces HTML/PDF only). Same section order as HTML: header,
 * summary, professional experience, earlier career, skills, education.
 * View-model text is emitted verbatim — Markdown has no escaping
 * boundary here because artifacts are generated files, not executed
 * markup, and every value is already validated upstream.
 */

function experienceLines(title: string, jobs: JobEntry[]): string[] {
  if (jobs.length === 0) {
    return [];
  }
  const lines = [`## ${title}`, ""];
  for (const job of jobs) {
    lines.push(`**${job.company}** | ${job.dates}`);
    lines.push(`*${job.role}* | ${job.location}`);
    for (const bullet of job.bullets) {
      lines.push(`- ${bullet}`);
    }
    lines.push("");
  }
  return lines;
}

/** Render the canonical view model to Markdown. */
export function renderMarkdown(viewModel: ResumeViewModel): string {
  const lines: string[] = [];
  lines.push(`# ${viewModel.header.full_name}`);
  lines.push("");
  const contacts = viewModel.header.contact_parts.map((part) => part.text).join(" | ");
  if (contacts !== "") {
    lines.push(contacts);
    lines.push("");
  }

  if (viewModel.summary_copy !== "") {
    lines.push("## Summary");
    lines.push("");
    lines.push(viewModel.summary_copy);
    lines.push("");
  }

  lines.push(...experienceLines("Professional Experience", viewModel.professional_experience));
  lines.push(...experienceLines("Earlier Career", viewModel.earlier_career));

  if (viewModel.skill_rows.length > 0) {
    lines.push("## Skills");
    lines.push("");
    for (const row of viewModel.skill_rows) {
      lines.push(`**${row.label}:** ${row.terms.join(", ")}`);
    }
    lines.push("");
  }

  if (viewModel.education_rows.length > 0) {
    lines.push("## Education");
    lines.push("");
    for (const edu of viewModel.education_rows) {
      const line = edu.dates !== "" ? `${edu.detail} (${edu.dates})` : edu.detail;
      lines.push(`- ${line}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
