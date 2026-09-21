import type { StoredProfilePayload } from "./candidate";

/**
 * Deterministic readable projections of one stored master payload
 * (WO-1.2-C). One fixed section order feeds both the settings full
 * preview and the Markdown export so the two cannot drift: the React
 * preview renders `MASTER_PREVIEW_SECTIONS` in order and the export
 * renderer below emits the same sections with the same content.
 * Content strings are emitted verbatim (no timestamps inside the
 * body), so identical payloads always produce identical bytes.
 */

export const MASTER_PREVIEW_SECTIONS = [
  "Summary",
  "Experience",
  "Skills",
  "Languages",
  "Education",
  "Credentials",
] as const;

export type MasterPreviewSection = (typeof MASTER_PREVIEW_SECTIONS)[number];

export interface MasterPayloadSummary {
  employments: number;
  achievements: number;
  approvedAchievements: number;
  pendingAchievements: number;
  skills: number;
  verifiedSkills: number;
  languages: number;
  education: number;
  credentials: number;
  hasLinks: boolean;
  hasSummary: boolean;
}

export function summarizeMasterPayload(payload: StoredProfilePayload): MasterPayloadSummary {
  let approvedAchievements = 0;
  let pendingAchievements = 0;
  for (const achievement of payload.achievements) {
    if (achievement.verification === "APPROVED") {
      approvedAchievements += 1;
    } else {
      pendingAchievements += 1;
    }
  }
  const links =
    payload.schemaVersion === "candidate-profile/v2" ? (payload.identity.links ?? null) : null;
  return {
    employments: payload.employment.length,
    achievements: payload.achievements.length,
    approvedAchievements,
    pendingAchievements,
    skills: payload.skills.length,
    verifiedSkills: payload.skills.filter((skill) => skill.verified).length,
    languages: "languages" in payload ? payload.languages.length : 0,
    education: payload.education.length,
    credentials: payload.credentials.length,
    hasLinks:
      links !== null &&
      (links.linkedin !== undefined ||
        links.github !== undefined ||
        links.portfolio !== undefined ||
        links.website !== undefined),
    hasSummary: payload.summary !== undefined,
  };
}

export interface MasterMarkdownMeta {
  profileDisplayName: string;
  version: number;
  /** True when no authored source bytes exist (rebuilt from payload). */
  reconstructed: boolean;
}

function formatDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

/**
 * Render one master payload as readable Markdown. Sections with no
 * content are omitted; the omission note at the end names what this
 * projection never carries (hashes, edit annotations, mutable
 * steering), so a missing section is never mistaken for missing data.
 */
export function renderMasterMarkdown(
  payload: StoredProfilePayload,
  meta: MasterMarkdownMeta,
): string {
  const lines: string[] = [];
  if (meta.reconstructed) {
    lines.push(
      "> Reconstructed from the stored version payload: no authored source bytes are recorded for this version.",
      "",
    );
  }
  lines.push(`# ${payload.identity.fullName}`, "");
  lines.push(
    `Master resume · profile “${meta.profileDisplayName}” · version ${meta.version}`,
    "",
  );
  if (payload.identity.headline !== undefined) {
    lines.push(payload.identity.headline, "");
  }
  const contact = [payload.identity.email, payload.identity.phone, payload.identity.location]
    .filter((entry) => entry !== undefined)
    .join(" · ");
  if (contact !== "") {
    lines.push(contact, "");
  }
  const links =
    payload.schemaVersion === "candidate-profile/v2" ? (payload.identity.links ?? null) : null;
  if (links !== null) {
    const entries = (
      [
        ["LinkedIn", links.linkedin],
        ["GitHub", links.github],
        ["Portfolio", links.portfolio],
        ["Website", links.website],
      ] as const
    ).filter(([, value]) => value !== undefined);
    for (const [label, value] of entries) {
      lines.push(`- ${label}: ${value}`);
    }
    if (entries.length > 0) {
      lines.push("");
    }
  }
  if (payload.targetTitles.length > 0) {
    lines.push(`Target titles: ${payload.targetTitles.join(", ")}`, "");
  }
  if (payload.targetLocations.length > 0) {
    lines.push(`Target locations: ${payload.targetLocations.join(", ")}`, "");
  }
  if (payload.summary !== undefined) {
    lines.push("## Summary", "", payload.summary, "");
  }
  if (payload.employment.length > 0) {
    lines.push("## Experience", "");
    const byEmployment = new Map<string, typeof payload.achievements>();
    const unassigned: typeof payload.achievements = [];
    for (const achievement of payload.achievements) {
      if (achievement.employmentId === undefined) {
        unassigned.push(achievement);
        continue;
      }
      const group = byEmployment.get(achievement.employmentId) ?? [];
      group.push(achievement);
      byEmployment.set(achievement.employmentId, group);
    }
    for (const job of payload.employment) {
      lines.push(`### ${job.role} · ${job.company}`);
      const range = job.isCurrent
        ? `${formatDate(job.startDate)} – present`
        : `${formatDate(job.startDate)} – ${job.endDate === undefined ? "—" : formatDate(job.endDate)}`;
      lines.push(job.location === undefined ? range : `${range} · ${job.location}`, "");
      if (job.description !== undefined) {
        lines.push(job.description, "");
      }
      for (const achievement of byEmployment.get(job.id) ?? []) {
        lines.push(
          `- ${achievement.text} \`[${achievement.factId} · ${achievement.verification}]\``,
        );
        if (achievement.technologies.length > 0) {
          lines.push(`  - Technologies: ${achievement.technologies.join(", ")}`);
        }
        if (achievement.metrics.length > 0) {
          lines.push(`  - Metrics: ${achievement.metrics.join("; ")}`);
        }
        if (achievement.source !== undefined) {
          lines.push(`  - Source: ${achievement.source}`);
        }
      }
      if ((byEmployment.get(job.id) ?? []).length > 0) {
        lines.push("");
      }
    }
    if (unassigned.length > 0) {
      lines.push("### Other achievements", "");
      for (const achievement of unassigned) {
        lines.push(
          `- ${achievement.text} \`[${achievement.factId} · ${achievement.verification}]\``,
        );
      }
      lines.push("");
    }
  }
  if (payload.skills.length > 0) {
    lines.push("## Skills", "");
    for (const skill of payload.skills) {
      const details = [
        skill.category,
        skill.proficiency,
        skill.yearsExperience === undefined ? undefined : `${skill.yearsExperience} yrs`,
        skill.verified ? "verified" : "unverified",
      ]
        .filter((entry) => entry !== undefined)
        .join(" · ");
      lines.push(`- ${skill.name} (${details})`);
    }
    lines.push("");
  }
  const languages = "languages" in payload ? payload.languages : [];
  if (languages.length > 0) {
    lines.push("## Languages", "");
    for (const language of languages) {
      const details = [
        language.proficiency,
        language.verified ? "verified" : "unverified",
      ]
        .filter((entry) => entry !== undefined)
        .join(" · ");
      lines.push(`- ${language.name} (${details})`);
    }
    lines.push("");
  }
  if (payload.education.length > 0) {
    lines.push("## Education", "");
    for (const entry of payload.education) {
      const what =
        entry.fieldOfStudy === undefined
          ? entry.degree
          : `${entry.degree}, ${entry.fieldOfStudy}`;
      const when =
        entry.startDate === undefined && entry.endDate === undefined
          ? ""
          : ` (${formatDate(entry.startDate ?? "—")} – ${entry.endDate === undefined ? "—" : formatDate(entry.endDate)})`;
      lines.push(`- ${what} · ${entry.institution}${when}`);
    }
    lines.push("");
  }
  if (payload.credentials.length > 0) {
    lines.push("## Credentials", "");
    for (const entry of payload.credentials) {
      const details = [
        entry.issuer,
        entry.issuedDate === undefined ? undefined : formatDate(entry.issuedDate),
        entry.credentialId,
      ]
        .filter((part) => part !== undefined)
        .join(" · ");
      lines.push(details === "" ? `- ${entry.name}` : `- ${entry.name} (${details})`);
    }
    lines.push("");
  }
  lines.push(
    "---",
    "",
    "Projection note: content hashes, fact edit annotations, and mutable steering (work preferences, career keywords, profile notes) are stored separately and never appear in this export.",
  );
  return `${lines.join("\n")}\n`;
}
