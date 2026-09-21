import { openRequestDatabase } from "@/app/api/_lib/request";
import {
  resolveMasterPreview,
  type MasterPreviewResult,
  type MasterPreviewSelection,
} from "@/src/server/masterPreview";

/**
 * Master resume preview: a readable rendering of one career profile's
 * master version. Opened from the drawer's Master Resume card and
 * version-history rows in a new tab. `?profile=<id>&version=<n>`
 * pins an explicit master so the link survives later default
 * switches and master updates; omitting identity keeps the legacy
 * default/active target (WO-1.2-F, F2). Request-time render (never
 * prerendered at build, where no product database exists); React
 * escapes every stored string.
 */
export const dynamic = "force-dynamic";

function parseSelection(searchParams: Record<string, string | string[] | undefined>): {
  selection: MasterPreviewSelection;
  error: string | null;
} {
  const rawProfile = searchParams["profile"];
  const rawVersion = searchParams["version"];
  const profile = Array.isArray(rawProfile) ? rawProfile[0] : rawProfile;
  const versionText = Array.isArray(rawVersion) ? rawVersion[0] : rawVersion;
  if (versionText !== undefined && !/^\d+$/.test(versionText)) {
    return { selection: {}, error: `Master version '${versionText}' is not a version number.` };
  }
  return {
    selection: {
      ...(profile === undefined || profile === "" ? {} : { profileId: profile }),
      ...(versionText === undefined ? {} : { version: Number(versionText) }),
    },
    error: null,
  };
}

async function loadView(
  selection: MasterPreviewSelection,
): Promise<MasterPreviewResult | { ok: false; error: "unavailable"; detail: string }> {
  try {
    const database = openRequestDatabase();
    if (!database.ok) {
      return { ok: false, error: "unavailable", detail: "The database is unavailable." };
    }
    try {
      return resolveMasterPreview(database.handle, selection);
    } finally {
      database.release();
    }
  } catch {
    return { ok: false, error: "unavailable", detail: "The master preview cannot be loaded." };
  }
}

function formatDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

interface MasterResumePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function MasterResumePage({ searchParams }: MasterResumePageProps) {
  const params = await searchParams;
  const parsed = parseSelection(params);
  const view = parsed.error === null ? await loadView(parsed.selection) : null;
  const failure = parsed.error ?? (view !== null && !view.ok ? view.detail : null);
  if (failure !== null || view === null || !view.ok) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-bold tracking-tight">Master Resume</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {failure ?? "No active master resume. Create a career profile and activate its master in Settings first."}
        </p>
      </main>
    );
  }
  const { payload } = view;
  const achievementsByEmployment = new Map<string, typeof payload.achievements>();
  const unassigned: typeof payload.achievements = [];
  for (const achievement of payload.achievements) {
    if (achievement.employmentId === undefined) {
      unassigned.push(achievement);
      continue;
    }
    const group = achievementsByEmployment.get(achievement.employmentId) ?? [];
    group.push(achievement);
    achievementsByEmployment.set(achievement.employmentId, group);
  }
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <header className="border-b border-border/60 pb-4">
        <p className="text-xs text-muted-foreground">
          {view.profileDisplayName} · version {view.version} · synced {formatDate(view.syncedAt)}
        </p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">{payload.identity.fullName}</h1>
        {payload.identity.headline !== undefined && (
          <p className="mt-1 text-sm text-muted-foreground">{payload.identity.headline}</p>
        )}
        <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
          {[
            payload.identity.email,
            payload.identity.phone,
            payload.identity.location,
          ]
            .filter((entry) => entry !== undefined)
            .join(" · ")}
        </p>
      </header>

      {payload.summary !== undefined && (
        <section aria-label="Summary" className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Summary
          </h2>
          <p className="mt-1 text-sm">{payload.summary}</p>
        </section>
      )}

      {payload.skills.length > 0 && (
        <section aria-label="Skills" className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Skills
          </h2>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {payload.skills.map((skill) => (
              <li
                key={skill.name}
                className="rounded-full border border-border/80 bg-muted/30 px-2.5 py-0.5 text-xs"
              >
                {skill.name}
                {skill.verified ? " ✓" : ""}
              </li>
            ))}
          </ul>
        </section>
      )}

      {payload.employment.length > 0 && (
        <section aria-label="Experience" className="mt-6 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Experience
          </h2>
          {payload.employment.map((job) => (
            <article key={job.id}>
              <h3 className="text-sm font-semibold">
                {job.role} · {job.company}
              </h3>
              <p className="font-mono text-xs tabular-nums text-muted-foreground">
                {formatDate(job.startDate)} –{" "}
                {job.isCurrent ? "present" : job.endDate === undefined ? "—" : formatDate(job.endDate)}
                {job.location === undefined ? "" : ` · ${job.location}`}
              </p>
              {job.description !== undefined && (
                <p className="mt-1 text-sm">{job.description}</p>
              )}
              {(achievementsByEmployment.get(job.id) ?? []).length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                  {(achievementsByEmployment.get(job.id) ?? []).map((achievement) => (
                    <li key={achievement.factId}>{achievement.text}</li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </section>
      )}

      {unassigned.length > 0 && (
        <section aria-label="Other achievements" className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Other Achievements
          </h2>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
            {unassigned.map((achievement) => (
              <li key={achievement.factId}>{achievement.text}</li>
            ))}
          </ul>
        </section>
      )}

      {payload.education.length > 0 && (
        <section aria-label="Education" className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Education
          </h2>
          <ul className="mt-1 space-y-1 text-sm">
            {payload.education.map((entry, index) => (
              // Education entries carry no stable id; the keyed prefix
              // keeps siblings distinct on this static server render.
              <li key={`${entry.institution}-${index}`}>
                {entry.degree}
                {entry.fieldOfStudy === undefined ? "" : `, ${entry.fieldOfStudy}`} ·{" "}
                {entry.institution}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
