/**
 * Shared settings client contracts (WO-1.2-C): profile mirrors,
 * readiness derivation, version shapes, and the cross-surface
 * settings opener. Pure — no React — so readiness and error mapping
 * stay unit-testable without a DOM.
 */

/** Client mirror of the server `ProfileSummary` work preferences. */
export interface SettingsWorkPreferences {
  workAuthorization: string[];
  workMode: string[];
  sponsorshipRequired: boolean | null;
  willingToRelocate: boolean | null;
  yearsOfExperience?: number;
  salaryExpectation?: {
    min?: number;
    target?: number;
    currency?: string;
    period?: "HOURLY" | "MONTHLY" | "ANNUAL";
  };
  targetTitles: string[];
  targetLocations: string[];
  careerKeywords: string[];
  profileNotes?: string;
}

/** Client mirror of the server `ProfileSummary`. */
export interface SettingsProfileSummary {
  id: string;
  name: string;
  displayName: string;
  isDefault: boolean;
  workPreferences: SettingsWorkPreferences | null;
  executiveNarrative: string | null;
  versionCount: number;
  latestVersion: number | null;
  latestVersionAt: string | null;
  activeVersion: number | null;
  approvedFacts: number;
  activeSource: {
    origin: string;
    byteSize: number;
    sha256: string;
    recordedAt: string;
  } | null;
}

export interface ProfileVersionEntry {
  id: string;
  version: number;
  createdAt: string;
  activatedAt: string | null;
  active: boolean;
  schemaVersion: string;
  payloadHash: string;
  facts: { total: number; approved: number };
  source: {
    origin: string;
    byteSize: number;
    sha256: string;
    recordedAt: string;
  } | null;
}

export type ProfileReadiness =
  | { state: "ready"; detail: string }
  | { state: "staged"; detail: string; version: number }
  | { state: "empty"; detail: string };

/**
 * Derive one profile's setup state from its summary. `ready` means a
 * human activated a master version; `staged` means versions exist but
 * none is active; `empty` means no master at all. Every state names
 * its precise next action — never a bare color or bare label.
 */
export function profileReadiness(profile: SettingsProfileSummary): ProfileReadiness {
  if (profile.activeVersion !== null) {
    const facts =
      profile.approvedFacts === 1 ? "1 approved fact" : `${profile.approvedFacts} approved facts`;
    return {
      state: "ready",
      detail: `Active master v${profile.activeVersion} · ${facts}.`,
    };
  }
  if (profile.latestVersion !== null) {
    return {
      state: "staged",
      version: profile.latestVersion,
      detail: `Version ${profile.latestVersion} staged but not active — review it below, then activate explicitly.`,
    };
  }
  return {
    state: "empty",
    detail: "No master yet — upload JSON, paste a document, or start from the example below.",
  };
}

/** Field-level validation issue as returned by the parse route. */
export interface MasterResumeIssue {
  path: Array<string | number>;
  message: string;
}

/** Dotted form of an issue path for display (`employment.0.endDate`). */
export function issuePathLabel(path: Array<string | number>): string {
  return path.map((segment) => String(segment)).join(".");
}

/** Group issues by their dotted path for control highlighting. */
export function groupIssuesByPath(
  issues: MasterResumeIssue[],
): Map<string, MasterResumeIssue[]> {
  const grouped = new Map<string, MasterResumeIssue[]>();
  for (const issue of issues) {
    const key = issuePathLabel(issue.path);
    const list = grouped.get(key) ?? [];
    list.push(issue);
    grouped.set(key, list);
  }
  return grouped;
}

export const OPEN_SETTINGS_EVENT = "job-tracker:open-settings";

export interface OpenSettingsDetail {
  tab: "data" | "ai" | "profile";
  profileId?: string;
}

/**
 * Ask the header-hosted settings modal to open at a tab, optionally
 * focused on one profile's setup. Used by drawer readiness notes so
 * an unready tailoring selection links to the exact profile setup.
 */
export function openSettings(tab: OpenSettingsDetail["tab"], profileId?: string): void {
  const detail: OpenSettingsDetail = { tab, ...(profileId === undefined ? {} : { profileId }) };
  window.dispatchEvent(new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, { detail }));
}
