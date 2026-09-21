"use client";

import { cn } from "@/lib/utils";

/** Parsed master payload (v1 or v2) as returned by the version-read route. */
export interface PreviewPayload {
  identity: {
    fullName: string;
    headline?: string;
    email?: string;
    phone?: string;
    location?: string;
    links?: {
      linkedin?: string;
      github?: string;
      portfolio?: string;
      website?: string;
    };
  };
  targetTitles: string[];
  targetLocations: string[];
  summary?: string;
  employment: Array<{
    id: string;
    company: string;
    role: string;
    location?: string;
    startDate: string;
    endDate?: string;
    isCurrent: boolean;
    description?: string;
  }>;
  achievements: Array<{
    factId: string;
    employmentId?: string;
    category: string;
    text: string;
    technologies: string[];
    metrics: string[];
    source?: string;
    verification: string;
  }>;
  skills: Array<{
    name: string;
    category?: string;
    proficiency?: string;
    yearsExperience?: number;
    verified: boolean;
  }>;
  languages?: Array<{ name: string; proficiency?: string; verified: boolean }>;
  education: Array<{
    degree: string;
    fieldOfStudy?: string;
    institution: string;
    startDate?: string;
    endDate?: string;
  }>;
  credentials: Array<{
    name: string;
    issuer?: string;
    issuedDate?: string;
    credentialId?: string;
  }>;
}

function formatDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

function verificationLabel(verification: string): string {
  if (verification === "APPROVED") return "Approved";
  if (verification === "REJECTED") return "Rejected";
  return "Pending review";
}

/**
 * Full parsed master preview (C4): every stored section in the same
 * order as the Markdown export — identity with links, summary,
 * experience with grouped achievements, skills, languages, education,
 * credentials. Verification is text, never color-only; the trailing
 * note names what this projection never carries.
 */
export default function MasterPreview({ payload }: { payload: PreviewPayload }) {
  const byEmployment = new Map<string, PreviewPayload["achievements"]>();
  const unassigned: PreviewPayload["achievements"] = [];
  for (const achievement of payload.achievements) {
    if (achievement.employmentId === undefined) {
      unassigned.push(achievement);
      continue;
    }
    const group = byEmployment.get(achievement.employmentId) ?? [];
    group.push(achievement);
    byEmployment.set(achievement.employmentId, group);
  }
  const links = payload.identity.links;
  const linkEntries =
    links === undefined
      ? []
      : (
          [
            ["LinkedIn", links.linkedin],
            ["GitHub", links.github],
            ["Portfolio", links.portfolio],
            ["Website", links.website],
          ] as const
        ).filter(([, value]) => value !== undefined);

  return (
    <div className="space-y-4 text-sm">
      <header className="border-b border-border/60 pb-3">
        <h4 className="text-lg font-bold tracking-tight">{payload.identity.fullName}</h4>
        {payload.identity.headline !== undefined && (
          <p className="mt-0.5 text-xs text-muted-foreground">{payload.identity.headline}</p>
        )}
        <p className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
          {[payload.identity.email, payload.identity.phone, payload.identity.location]
            .filter((entry) => entry !== undefined)
            .join(" · ")}
        </p>
        {linkEntries.length > 0 && (
          <ul className="mt-1 space-y-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
            {linkEntries.map(([label, value]) => (
              <li key={label}>
                {label}: {value}
              </li>
            ))}
          </ul>
        )}
        {payload.targetTitles.length > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Target titles: {payload.targetTitles.join(", ")}
          </p>
        )}
        {payload.targetLocations.length > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Target locations: {payload.targetLocations.join(", ")}
          </p>
        )}
      </header>

      {payload.summary !== undefined && (
        <section aria-label="Summary">
          <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Summary
          </h5>
          <p className="mt-1 text-sm">{payload.summary}</p>
        </section>
      )}

      {payload.employment.length > 0 && (
        <section aria-label="Experience" className="space-y-3">
          <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Experience
          </h5>
          {payload.employment.map((job) => (
            <article key={job.id}>
              <h6 className="text-sm font-semibold">
                {job.role} · {job.company}
              </h6>
              <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {formatDate(job.startDate)} –{" "}
                {job.isCurrent ? "present" : job.endDate === undefined ? "—" : formatDate(job.endDate)}
                {job.location === undefined ? "" : ` · ${job.location}`}
              </p>
              {job.description !== undefined && <p className="mt-1 text-sm">{job.description}</p>}
              {(byEmployment.get(job.id) ?? []).length > 0 && (
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                  {(byEmployment.get(job.id) ?? []).map((achievement) => (
                    <li key={achievement.factId}>
                      {achievement.text}{" "}
                      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                        [{achievement.factId} · {verificationLabel(achievement.verification)}]
                      </span>
                      {achievement.technologies.length > 0 && (
                        <span className="block text-xs text-muted-foreground">
                          Technologies: {achievement.technologies.join(", ")}
                        </span>
                      )}
                      {achievement.metrics.length > 0 && (
                        <span className="block text-xs text-muted-foreground">
                          Metrics: {achievement.metrics.join("; ")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
          {unassigned.length > 0 && (
            <article>
              <h6 className="text-sm font-semibold">Other achievements</h6>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                {unassigned.map((achievement) => (
                  <li key={achievement.factId}>
                    {achievement.text}{" "}
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      [{achievement.factId} · {verificationLabel(achievement.verification)}]
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          )}
        </section>
      )}

      {payload.skills.length > 0 && (
        <section aria-label="Skills">
          <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Skills
          </h5>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {payload.skills.map((skill, index) => (
              <li
                key={`${skill.name}-${index}`}
                className={cn(
                  "rounded-full border border-border/80 bg-muted/30 px-2.5 py-0.5 text-xs",
                  skill.verified && "border-emerald-500/40",
                )}
              >
                {skill.name}
                {skill.category === undefined ? "" : ` · ${skill.category}`}
                {skill.verified ? " · verified" : ""}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(payload.languages ?? []).length > 0 && (
        <section aria-label="Languages">
          <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Languages
          </h5>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {(payload.languages ?? []).map((language, index) => (
              <li
                key={`${language.name}-${index}`}
                className="rounded-full border border-border/80 bg-muted/30 px-2.5 py-0.5 text-xs"
              >
                {language.name}
                {language.proficiency === undefined ? "" : ` · ${language.proficiency}`}
                {language.verified ? " · verified" : ""}
              </li>
            ))}
          </ul>
        </section>
      )}

      {payload.education.length > 0 && (
        <section aria-label="Education">
          <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Education
          </h5>
          <ul className="mt-1 space-y-1 text-sm">
            {payload.education.map((entry, index) => (
              <li key={`${entry.institution}-${index}`}>
                {entry.degree}
                {entry.fieldOfStudy === undefined ? "" : `, ${entry.fieldOfStudy}`} ·{" "}
                {entry.institution}
              </li>
            ))}
          </ul>
        </section>
      )}

      {payload.credentials.length > 0 && (
        <section aria-label="Credentials">
          <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Credentials
          </h5>
          <ul className="mt-1 space-y-1 text-sm">
            {payload.credentials.map((entry, index) => (
              <li key={`${entry.name}-${index}`}>
                {entry.name}
                {entry.issuer === undefined ? "" : ` · ${entry.issuer}`}
                {entry.credentialId === undefined ? "" : (
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {" "}
                    [{entry.credentialId}]
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="border-t border-border/40 pt-2 text-[11px] text-muted-foreground">
        Projection note: content hashes, fact edit annotations, and mutable steering (work
        preferences, career keywords, profile notes) live separately and never appear here.
      </p>
    </div>
  );
}
