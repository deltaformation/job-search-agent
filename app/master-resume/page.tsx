import { openRequestDatabase } from "@/app/api/_lib/request";
import { getActiveProfileVersion, getDefaultProfile } from "@/src/db/candidates";
import type { DatabaseHandle } from "@/src/db/client";
import { CandidateProfilePayloadV1 } from "@/src/domain/candidate";

/**
 * Master resume preview: a readable rendering of the default career
 * profile's active version. Opened from the drawer's Master Resume card
 * in a new tab. Request-time render (never prerendered at build, where
 * no product database exists); React escapes every stored string.
 */
export const dynamic = "force-dynamic";

interface MasterResumeView {
  profileName: string;
  profileDisplayName: string;
  version: number;
  syncedAt: string;
  payload: ReturnType<typeof CandidateProfilePayloadV1.parse>;
}

function loadMasterResume(handle: DatabaseHandle): MasterResumeView | null {
  const profile = getDefaultProfile(handle);
  if (profile === null) {
    return null;
  }
  const active = getActiveProfileVersion(handle, profile.id);
  if (active === null) {
    return null;
  }
  let payload: MasterResumeView["payload"];
  try {
    payload = CandidateProfilePayloadV1.parse(JSON.parse(active.payloadJson) as unknown);
  } catch {
    return null;
  }
  return {
    profileName: profile.name,
    profileDisplayName: profile.displayName,
    version: active.version,
    syncedAt: active.createdAt,
    payload,
  };
}

async function loadView(): Promise<MasterResumeView | null> {
  try {
    const database = openRequestDatabase();
    if (!database.ok) {
      return null;
    }
    try {
      return loadMasterResume(database.handle);
    } finally {
      database.release();
    }
  } catch {
    return null;
  }
}

function formatDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

export default async function MasterResumePage() {
  const view = await loadView();
  if (view === null) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-bold tracking-tight">Master Resume</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          No active master resume. Add{" "}
          <span className="font-mono tabular-nums">data/candidate/master-resume.json</span> and
          re-sync from Settings first.
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
