import { createHash } from "node:crypto";
import { RESUME_CONFIG } from "./config";
import type { ContactPart, JobEntry, ResumeViewModel } from "./viewModel";

/**
 * Trusted resume HTML template (reviewed port of
 * `services/documents/templates/mouad_standard_v1.html.j2`).
 *
 * Only allow-listed, checked-in markup may render. The reference HTML from
 * the legacy design process is untrusted design input and is never read.
 * Unknown template IDs fail closed. Static markup lives in `const`
 * fragments below; the renderer only substitutes escaped view-model
 * values — presentation-only, no scripts, no external assets.
 *
 * Template lineage: `templateHash()` is the SHA-256 of every static
 * fragment in document order, so any markup change alters the lineage
 * binding exactly like the oracle's template-file digest.
 */

// CSS below is verbatim from the reviewed oracle template.
const TEMPLATE_CSS = `  @page {
    size: Letter 8.5in 11in;
    margin: 0.68in 0.74in 0.62in;
  }
  body {
    margin: 0;
    padding: 0;
    color: #292929;
    background: #ffffff;
    font-family: Arial, "Helvetica Neue", Helvetica, sans-serif;
    font-size: 10.35pt;
    line-height: 1.36;
  }
  .resume-header {
    margin-bottom: 17pt;
    text-align: center;
  }
  h1 {
    margin: 0 0 3pt;
    color: #213c6b;
    font-size: 20.5pt;
    line-height: 1.05;
    letter-spacing: 0.018em;
    text-transform: uppercase;
  }
  .contact-line {
    margin: 0;
    color: #595959;
    font-size: 9.65pt;
    line-height: 1.25;
  }
  .contact-line a {
    color: inherit;
    text-decoration: none;
  }
  .separator {
    padding: 0 0.32em;
    color: #737373;
  }
  section {
    margin: 0;
  }
  .section-title {
    margin: 14pt 0 7pt;
    padding: 0 0 3pt;
    border-bottom: 1.5pt solid #213c6b;
    color: #213c6b;
    font-size: 10.8pt;
    line-height: 1.1;
    letter-spacing: 0.015em;
    text-transform: uppercase;
    break-after: avoid;
    page-break-after: avoid;
  }
  .summary .section-title {
    margin-top: 0;
  }
  p {
    margin: 0;
  }
  .summary-copy {
    font-size: 10.35pt;
  }
  .job {
    margin: 0 0 9.5pt;
  }
  .job:last-child {
    margin-bottom: 0;
  }
  .job-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      "company dates"
      "role location";
    column-gap: 18pt;
    align-items: baseline;
    margin-bottom: 2.5pt;
    break-after: avoid;
    page-break-after: avoid;
  }
  .company {
    grid-area: company;
    margin: 0;
    font-size: 10.35pt;
    line-height: 1.2;
    font-weight: 700;
  }
  .job-title {
    grid-area: role;
    font-style: italic;
    line-height: 1.25;
  }
  .dates,
  .location {
    color: #595959;
    line-height: 1.25;
    text-align: right;
    white-space: nowrap;
  }
  .dates {
    grid-area: dates;
  }
  .location {
    grid-area: location;
  }
  ul {
    margin: 0;
    padding: 0 0 0 15pt;
  }
  li {
    margin: 0 0 2.3pt;
    padding-left: 1.5pt;
    orphans: 2;
    widows: 2;
  }
  li:last-child {
    margin-bottom: 0;
  }
  .skills-list {
    display: grid;
    gap: 3.1pt;
  }
  .skill-label {
    font-weight: 700;
  }
  .education-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 18pt;
    align-items: baseline;
  }
  .school {
    font-weight: 700;
  }`;

const SHELL_TOP = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src 'none'; img-src 'none';">
<style>
${TEMPLATE_CSS}
</style>
</head>
<body>

<header class="resume-header">
  <h1>__FULL_NAME__</h1>
  <p class="contact-line">__CONTACT_LINE__</p>
</header>

__SECTIONS__</body>
</html>
`;

const CONTACT_SEPARATOR = `<span class="separator" aria-hidden="true">|</span>`;

const SUMMARY_SECTION = `<section class="summary" aria-labelledby="summary-heading">
  <h2 class="section-title" id="summary-heading">Summary</h2>
  <p class="summary-copy">__COPY__</p>
</section>

`;

const EXPERIENCE_SECTION = `<section aria-labelledby="__HEADING_ID__">
  <h2 class="section-title" id="__HEADING_ID__">__TITLE__</h2>
__JOBS__</section>

`;

const JOB_ARTICLE = `  <article class="job">
    <header class="job-header">
      <h3 class="company">__COMPANY__</h3>
      <div class="dates">__DATES__</div>
      <div class="job-title">__ROLE__</div>
      <div class="location">__LOCATION__</div>
    </header>
    <ul>
__BULLETS__    </ul>
  </article>
`;

const BULLET_ITEM = `      <li>__TEXT__</li>
`;

const SKILLS_SECTION = `<section aria-labelledby="skills-heading">
  <h2 class="section-title" id="skills-heading">Skills</h2>
  <div class="skills-list">
__ROWS__  </div>
</section>

`;

const SKILL_ROW = `    <p><span class="skill-label">__LABEL__:</span> __TERMS__</p>
`;

const EDUCATION_SECTION = `<section aria-labelledby="education-heading">
  <h2 class="section-title" id="education-heading">Education</h2>
__ROWS__</section>

`;

const EDUCATION_ROW = `  <div class="education-row">
    <p><span class="school">__SCHOOL__</span>__DETAIL__</p>
    <p class="dates">__DATES__</p>
  </div>
`;

/** Static fragments in document order; the lineage hash input. */
const TEMPLATE_FRAGMENTS = [
  SHELL_TOP,
  CONTACT_SEPARATOR,
  SUMMARY_SECTION,
  EXPERIENCE_SECTION,
  JOB_ARTICLE,
  BULLET_ITEM,
  SKILLS_SECTION,
  SKILL_ROW,
  EDUCATION_SECTION,
  EDUCATION_ROW,
];

export const STANDARD_TEMPLATE_ID = "mouad_standard_v1";

const ALLOWED_TEMPLATES: Readonly<Record<string, { version: string }>> = {
  [STANDARD_TEMPLATE_ID]: { version: "v1" },
};

/** Mirror of `TemplateRegistry.get_template` (source digest for lineage). */
export function getTemplate(templateId: string): { source: string; digest: string } {
  const entry = ALLOWED_TEMPLATES[templateId];
  if (entry === undefined) {
    throw new Error(`Unknown resume template: ${JSON.stringify(templateId)}.`);
  }
  const source = TEMPLATE_FRAGMENTS.join("\n<!-- fragment -->\n");
  const digest = createHash("sha256").update(source, "utf8").digest("hex");
  return { source, digest };
}

export function allowedTemplateIds(): string[] {
  return Object.keys(ALLOWED_TEMPLATES).sort();
}

export interface TemplateInfo {
  template_id: string;
  template_version: string;
  template_hash: string;
  render_schema_version: string;
}

/** Mirror of `DocumentRenderer.template_info`. */
export function templateInfo(templateId: string = RESUME_CONFIG.defaultTemplate): TemplateInfo {
  const { digest } = getTemplate(templateId);
  const entry = ALLOWED_TEMPLATES[templateId] as { version: string };
  return {
    template_id: templateId,
    template_version: entry.version,
    template_hash: digest,
    render_schema_version: RESUME_CONFIG.renderSchemaVersion,
  };
}

/**
 * HTML escaping with markupsafe/Jinja-autoescape fidelity (`"` → `&#34;`,
 * `'` → `&#x27;`). Every view-model value passes through here.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&#34;")
    .replace(/'/g, "&#x27;");
}

const SAFE_HREF_SCHEMES = ["tel:", "mailto:", "http://", "https://"];

/**
 * Link targets are escaped AND scheme-allowlisted. A `javascript:` URL in
 * profile data renders as inert text — a deliberate hardening over the
 * oracle, which escapes but does not scheme-check.
 */
export function safeHref(href: string): string | null {
  const lowered = href.trim().toLowerCase();
  if (SAFE_HREF_SCHEMES.some((scheme) => lowered.startsWith(scheme))) {
    return href;
  }
  return null;
}

function fill(template: string, slots: Record<string, string>): string {
  let out = template;
  for (const [token, value] of Object.entries(slots)) {
    out = out.split(token).join(value);
  }
  return out;
}

function renderContactLine(parts: ContactPart[]): string {
  return parts
    .map((part) => {
      const text = escapeHtml(part.text);
      if (part.href === undefined) {
        return text;
      }
      const href = safeHref(part.href);
      if (href === null) {
        return text;
      }
      return `<a href="${escapeHtml(href)}">${text}</a>`;
    })
    .join(CONTACT_SEPARATOR);
}

function renderJob(job: JobEntry): string {
  const bullets = job.bullets.map((bullet) => fill(BULLET_ITEM, { __TEXT__: escapeHtml(bullet) }));
  return fill(JOB_ARTICLE, {
    __COMPANY__: escapeHtml(job.company),
    __DATES__: escapeHtml(job.dates),
    __ROLE__: escapeHtml(job.role),
    __LOCATION__: escapeHtml(job.location),
    __BULLETS__: bullets.join(""),
  });
}

function renderExperienceSection(headingId: string, title: string, jobs: JobEntry[]): string {
  if (jobs.length === 0) {
    return "";
  }
  return fill(EXPERIENCE_SECTION, {
    __HEADING_ID__: headingId,
    __TITLE__: title,
    __JOBS__: jobs.map(renderJob).join(""),
  });
}

/** Render the canonical view model to standalone trusted HTML. */
export function renderHtml(viewModel: ResumeViewModel): string {
  const sections: string[] = [];
  if (viewModel.summary_copy !== "") {
    sections.push(fill(SUMMARY_SECTION, { __COPY__: escapeHtml(viewModel.summary_copy) }));
  }
  sections.push(renderExperienceSection("experience-heading", "Professional Experience", viewModel.professional_experience));
  sections.push(renderExperienceSection("earlier-heading", "Earlier Career", viewModel.earlier_career));
  if (viewModel.skill_rows.length > 0) {
    const rows = viewModel.skill_rows.map((row) =>
      fill(SKILL_ROW, {
        __LABEL__: escapeHtml(row.label),
        __TERMS__: escapeHtml(row.terms.join(", ")),
      }),
    );
    sections.push(fill(SKILLS_SECTION, { __ROWS__: rows.join("") }));
  }
  if (viewModel.education_rows.length > 0) {
    const rows = viewModel.education_rows.map((edu) =>
      fill(EDUCATION_ROW, {
        __SCHOOL__: escapeHtml(edu.school),
        __DETAIL__: escapeHtml(edu.detail),
        __DATES__: escapeHtml(edu.dates),
      }),
    );
    sections.push(fill(EDUCATION_SECTION, { __ROWS__: rows.join("") }));
  }
  return fill(SHELL_TOP, {
    __FULL_NAME__: escapeHtml(viewModel.header.full_name),
    __CONTACT_LINE__: renderContactLine(viewModel.header.contact_parts),
    __SECTIONS__: sections.join(""),
  });
}
