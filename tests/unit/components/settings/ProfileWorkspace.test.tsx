import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProfileWorkspace from "../../../../components/settings/ProfileWorkspace";
import type { SettingsProfileSummary } from "../../../../components/settings/profiles";

/**
 * WO-1.2-C: the per-profile workspace shows readiness with its next
 * action, saves preferences without touching masters, lists immutable
 * history with preview/exports, and activates drafts explicitly.
 */

const profile: SettingsProfileSummary = {
  id: "profile-2",
  name: "spm",
  displayName: "Senior Product Manager",
  isDefault: false,
  workPreferences: {
    workAuthorization: ["US citizen"],
    workMode: ["REMOTE"],
    sponsorshipRequired: null,
    willingToRelocate: false,
    targetTitles: ["Senior PM"],
    targetLocations: [],
    careerKeywords: [],
  },
  executiveNarrative: "Narrative.",
  versionCount: 1,
  latestVersion: 1,
  latestVersionAt: "2026-09-12T00:00:00.000Z",
  activeVersion: null,
  approvedFacts: 0,
  activeSource: null,
};

const versions = [
  {
    id: "version-1",
    version: 1,
    createdAt: "2026-09-12T00:00:00.000Z",
    activatedAt: null,
    active: false,
    schemaVersion: "candidate-profile/v2",
    payloadHash: "ab".repeat(32),
    facts: { total: 2, approved: 0 },
    source: { origin: "copy", byteSize: 120, sha256: "cd".repeat(32), recordedAt: "2026-09-12T00:00:00.000Z" },
  },
];

afterEach(() => vi.unstubAllGlobals());

function mockFetch() {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({
      url,
      method: init?.method,
      body: init?.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
    });
    if (url === "/api/settings/profiles/profile-2/versions") {
      return { ok: true, status: 200, json: async () => ({ versions }) };
    }
    if (url === "/api/settings/profiles/profile-2/versions/version-1") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          payload: {
            identity: { fullName: "Sam Senior" },
            targetTitles: [],
            targetLocations: [],
            employment: [],
            achievements: [],
            skills: [],
            languages: [],
            education: [],
            credentials: [],
          },
        }),
      };
    }
    if (url === "/api/settings/profiles/profile-2/activate") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, version: 1, alreadyActive: false }),
      };
    }
    if (url === "/api/settings/profiles/profile-2") {
      return { ok: true, status: 200, json: async () => ({ profile }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function setup() {
  const onChanged = vi.fn(async () => {});
  render(
    <ProfileWorkspace
      profile={profile}
      busy={null}
      versionsTick={0}
      onRun={async (_action, fn) => {
        await fn();
      }}
      onProfilesChanged={onChanged}
      onDirtyChange={() => {}}
    />,
  );
  return { onChanged };
}

describe("ProfileWorkspace", () => {
  it("shows staged readiness with the activation action", async () => {
    mockFetch();
    setup();
    expect(screen.getByText("Master staged — activation needed")).toBeVisible();
    expect(screen.getByText(/review it below, then activate explicitly/i)).toBeVisible();
    await waitFor(() => expect(screen.getByText("v1")).toBeVisible());
  });

  it("lists history with draft state, facts, source, and per-version exports", async () => {
    mockFetch();
    setup();
    await waitFor(() => expect(screen.getByText("v1")).toBeVisible());
    expect(screen.getByText("Draft")).toBeVisible();
    expect(screen.getByText(/2 facts · 0 approved · copy · 120 B/)).toBeVisible();
    expect(screen.getByText("JSON")).toHaveAttribute(
      "href",
      "/api/settings/profiles/profile-2/versions/version-1/export?format=json",
    );
    expect(screen.getByText("Markdown")).toHaveAttribute(
      "href",
      "/api/settings/profiles/profile-2/versions/version-1/export?format=md",
    );
  });

  it("activates a draft explicitly and refreshes", async () => {
    mockFetch();
    const { onChanged } = setup();
    await waitFor(() => expect(screen.getByText("v1")).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("expands the full preview for one version", async () => {
    mockFetch();
    setup();
    await waitFor(() => expect(screen.getByText("v1")).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Sam Senior" })).toBeVisible(),
    );
  });

  it("saves the full preference inventory including unknowns without touching masters", async () => {
    const calls = mockFetch();
    setup();
    await waitFor(() => expect(screen.getByText("v1")).toBeVisible());
    const prefs = within(screen.getByRole("region", { name: "Preferences" }));
    expect(prefs.getByLabelText("Display name")).toHaveValue("Senior Product Manager");
    expect(prefs.getByLabelText("Sponsorship required")).toHaveValue("");
    fireEvent.change(prefs.getByLabelText("Target titles (one per line)"), {
      target: { value: "Senior PM\nStaff PM" },
    });
    fireEvent.change(prefs.getByLabelText("Career keywords (one per line)"), {
      target: { value: "platform\nB2B SaaS" },
    });
    fireEvent.change(prefs.getByLabelText("Period"), { target: { value: "ANNUAL" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() =>
      expect(
        calls.some((entry) => entry.url === "/api/settings/profiles/profile-2" && entry.method === "PATCH"),
      ).toBe(true),
    );
    const patch = calls.find(
      (entry) => entry.url === "/api/settings/profiles/profile-2" && entry.method === "PATCH",
    );
    expect(patch?.body).toMatchObject({
      displayName: "Senior Product Manager",
      workPreferences: {
        workAuthorization: ["US citizen"],
        workMode: ["REMOTE"],
        sponsorshipRequired: null,
        willingToRelocate: false,
        targetTitles: ["Senior PM", "Staff PM"],
        careerKeywords: ["platform", "B2B SaaS"],
        salaryExpectation: { period: "ANNUAL" },
      },
      executiveNarrative: "Narrative.",
    });
    // No master write rode along.
    expect(calls.some((entry) => entry.url.includes("/activate"))).toBe(false);
    expect(calls.some((entry) => entry.url === "/api/settings/master-resume")).toBe(false);
  });
});
