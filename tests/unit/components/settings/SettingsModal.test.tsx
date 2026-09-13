import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import SettingsModal from "../../../../components/settings/SettingsModal";

const snapshot = {
  models: { primary: "provider/primary", fallback: "provider/fallback" },
  activeProvider: "openrouter",
  providers: {
    openrouter: {
      configured: false,
      fingerprint: null,
      models: { primary: "provider/primary", fallback: "provider/fallback" },
    },
    google: {
      configured: true,
      fingerprint: "abc12345",
      models: { primary: "gemini-2.5-pro", fallback: "gemini-2.5-flash" },
    },
    meta: {
      configured: false,
      fingerprint: null,
      models: { primary: "meta-muse", fallback: "meta-muse" },
    },
  },
  openRouter: { configured: false, fingerprint: null },
  profile: { activeVersion: 2, activeVersionAt: "2026-09-01T12:00:00.000Z", displayName: "Test candidate", approvedFacts: 5, verifiedSkills: 3 },
  storage: { databaseBytes: 100, walBytes: 0, jobCount: 4, evidenceBytes: 20, evidenceFiles: 1,
    artifactBytes: 30, artifactFiles: 3, backupCount: 0, backupsBytes: 0 },
};

afterEach(() => vi.unstubAllGlobals());

const profileSummaries = [
  {
    id: "profile-1",
    name: "staff-engineer",
    displayName: "Staff Engineer",
    isDefault: true,
    workPreferences: {
      workAuthorization: ["US citizen"],
      workMode: ["REMOTE"],
      sponsorshipRequired: false,
      willingToRelocate: false,
      yearsOfExperience: 9,
      targetTitles: [],
      targetLocations: [],
    },
    executiveNarrative: "Platform narrative.",
    versionCount: 2,
    latestVersion: 2,
    latestVersionAt: "2026-09-01T12:00:00.000Z",
    activeVersion: 2,
    approvedFacts: 5,
  },
  {
    id: "profile-2",
    name: "engineering-manager",
    displayName: "Engineering Manager",
    isDefault: false,
    workPreferences: null,
    executiveNarrative: null,
    versionCount: 0,
    latestVersion: null,
    latestVersionAt: null,
    activeVersion: null,
    approvedFacts: 0,
  },
];

/** Route-aware fetch mock: settings snapshot, profile list, and canned writes. */
function mockFetch(options: {
  profiles?: unknown[];
  onWrite?: (url: string, init?: { method?: string; body?: string }) => unknown;
} = {}) {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url === "/api/settings/profiles" && (init?.method ?? "GET") === "GET") {
      return { ok: true, status: 200, json: async () => ({ profiles: options.profiles ?? [] }) };
    }
    if (options.onWrite !== undefined && init?.method !== undefined && init.method !== "GET") {
      const payload = options.onWrite(url, init);
      if (payload !== undefined) {
        return { ok: true, status: 200, json: async () => payload };
      }
    }
    return { ok: true, status: 200, json: async () => snapshot };
  });
}

function setup() {
  const fetchMock = mockFetch();
  vi.stubGlobal("fetch", fetchMock);
  const onOpenChange = vi.fn();
  render(<SettingsModal open onOpenChange={onOpenChange} />);
  return { fetchMock, onOpenChange };
}

function setupProfiles(options?: { profiles?: unknown[]; onWrite?: (url: string, init?: { method?: string; body?: string }) => unknown }) {
  const fetchMock = mockFetch(options);
  vi.stubGlobal("fetch", fetchMock);
  render(<SettingsModal open onOpenChange={() => {}} />);
  selectTab("Candidate Profile");
  return { fetchMock };
}

function selectTab(name: string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0, ctrlKey: false });
}

it("preserves draft inputs across settings tabs without submitting anything", async () => {
  const { fetchMock } = setup();
  // Inactive panels mount on selection, so navigate before asserting fields.
  expect(screen.getByRole("tab", { name: "Data & Backup" })).toHaveAttribute("aria-selected", "true");
  selectTab("AI & Models");
  await waitFor(() => expect(screen.getByLabelText("Primary model")).toHaveValue("provider/primary"));
  fireEvent.change(screen.getByLabelText("Primary model"), { target: { value: "provider/draft" } });
  selectTab("Candidate Profile");
  expect(screen.getByText("Test candidate")).toBeVisible();
  selectTab("AI & Models");
  expect(screen.getByLabelText("Primary model")).toHaveValue("provider/draft");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual([
    "/api/settings",
    "/api/settings/profiles",
  ]);
});

it("preserves the type-to-confirm reset gate when tabs are interrupted", async () => {
  const { fetchMock, onOpenChange } = setup();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Clear All Jobs…" }));
  expect(screen.getByRole("button", { name: "Confirm Reset" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Type RESET to confirm board reset"), { target: { value: "RES" } });
  selectTab("AI & Models");
  selectTab("Data & Backup");
  expect(screen.getByLabelText("Type RESET to confirm board reset")).toHaveValue("RES");
  expect(screen.getByRole("button", { name: "Confirm Reset" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("button", { name: "Confirm Reset" })).toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual([
    "/api/settings",
    "/api/settings/profiles",
  ]);
});

it("auto-dismisses settings successes while [X] clears them at once", async () => {
  vi.useFakeTimers();
  try {
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url === "/api/settings/model" && init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ primary: "p", fallback: "f", restartRequired: true }),
        };
      }
      return { ok: true, status: 200, json: async () => snapshot };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SettingsModal open onOpenChange={() => {}} />);
    selectTab("AI & Models");
    await vi.waitFor(() =>
      expect(screen.getByLabelText("Primary model")).toHaveValue("provider/primary"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Models" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/model chain saved/i),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save Models" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/model chain saved/i),
    );
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(screen.queryByRole("status")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("keeps settings errors until manually dismissed", async () => {
  vi.useFakeTimers();
  try {
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url === "/api/settings/model" && init?.method === "POST") {
        return { ok: false, status: 500, json: async () => ({ error: "write failed" }) };
      }
      return { ok: true, status: 200, json: async () => snapshot };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SettingsModal open onOpenChange={() => {}} />);
    selectTab("AI & Models");
    await vi.waitFor(() =>
      expect(screen.getByLabelText("Primary model")).toHaveValue("provider/primary"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Models" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/write failed/i),
    );
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/write failed/i);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByRole("alert")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("shows provider cards with status and saves the selected chain", async () => {
  const { fetchMock } = setup();
  selectTab("AI & Models");
  await waitFor(() =>
    expect(screen.getByLabelText("Primary model")).toHaveValue("provider/primary"),
  );
  expect(screen.getByRole("radio", { name: /Google AI Studio/ })).toHaveTextContent(
    "Connected · abc12345",
  );
  expect(screen.getByRole("radio", { name: /Meta Muse/ })).toHaveTextContent(
    "Key Missing in .env.local",
  );
  fireEvent.click(screen.getByRole("radio", { name: /Google AI Studio/ }));
  expect(screen.getByRole("radio", { name: /Google AI Studio/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(screen.getByLabelText("Primary model")).toHaveValue("gemini-2.5-pro");
  expect(screen.getByLabelText("Fallback model")).toHaveValue("gemini-2.5-flash");
  fireEvent.click(screen.getByRole("button", { name: "Save Models" }));
  await waitFor(() =>
    expect(screen.getByText(/model chain saved/i)).toBeInTheDocument(),
  );
  const modelPost = fetchMock.mock.calls.find(
    ([url]) => url === "/api/settings/model",
  ) as [string, { body: string } | undefined] | undefined;
  expect(modelPost).toBeDefined();
  expect(JSON.parse(modelPost?.[1]?.body ?? "{}")).toEqual({
    provider: "google",
    googleModel: "gemini-2.5-pro",
    googleFallbackModel: "gemini-2.5-flash",
  });
});

it("tests the selected provider and shows latency", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/settings/ai-test") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, model: "gemini-2.5-pro", latencyMs: 342, error: null }),
      };
    }
    return { ok: true, status: 200, json: async () => snapshot };
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SettingsModal open onOpenChange={() => {}} />);
  selectTab("AI & Models");
  await waitFor(() =>
    expect(screen.getByLabelText("Primary model")).toHaveValue("provider/primary"),
  );
  fireEvent.click(screen.getByRole("radio", { name: /Google AI Studio/ }));
  fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
  await waitFor(() =>
    expect(screen.getByText("✓ Connected (342 ms, gemini-2.5-pro)")).toBeInTheDocument(),
  );
  const pingPost = fetchMock.mock.calls.find(
    ([url]) => url === "/api/settings/ai-test",
  ) as [string, { body: string } | undefined] | undefined;
  expect(JSON.parse(pingPost?.[1]?.body ?? "{}")).toEqual({ provider: "google" });
});

it("renders career profiles with default badge and master resume metadata", async () => {
  setupProfiles({ profiles: profileSummaries });
  await waitFor(() => expect(screen.getByText("Staff Engineer")).toBeVisible());
  expect(screen.getByText("Engineering Manager")).toBeVisible();
  expect(screen.getByText("Default")).toBeVisible();
  expect(screen.getByText(/staff-engineer · 2 versions · 5 facts/)).toHaveTextContent(
    "active v2",
  );
  expect(screen.getByRole("button", { name: "Set Default" })).toBeVisible();
  expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(2);
  expect(screen.getByText("Test candidate")).toBeVisible();
  expect(screen.getByText("Download JSON")).toHaveAttribute("href", "/api/settings/master-resume");
});

it("switches the default profile from the card list", async () => {
  const { fetchMock } = setupProfiles({
    profiles: profileSummaries,
    onWrite: (url) =>
      url === "/api/settings/profiles/profile-2/set-default"
        ? { ok: true, defaultProfileId: "profile-2" }
        : undefined,
  });
  await waitFor(() => expect(screen.getByText("Engineering Manager")).toBeVisible());
  fireEvent.click(screen.getByRole("button", { name: "Set Default" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(/default career profile is now/i),
  );
  const call = fetchMock.mock.calls.find(
    ([url, init]) =>
      url === "/api/settings/profiles/profile-2/set-default" &&
      (init as { method?: string } | undefined)?.method === "POST",
  );
  expect(call).toBeDefined();
});

it("creates a career profile from the inline form", async () => {
  const { fetchMock } = setupProfiles({
    profiles: [],
    onWrite: (url) =>
      url === "/api/settings/profiles"
        ? { profile: { ...profileSummaries[1], id: "profile-9" } }
        : undefined,
  });
  await waitFor(() => expect(screen.getByText(/no career profiles yet/i)).toBeVisible());
  fireEvent.click(screen.getByRole("button", { name: "New Career Profile" }));
  fireEvent.change(screen.getByLabelText("Name (slug)"), { target: { value: "data-lead" } });
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Data Lead" } });
  fireEvent.click(screen.getByLabelText("Remote"));
  fireEvent.click(screen.getByLabelText("Hybrid"));
  fireEvent.change(screen.getByLabelText("Work authorization (comma-separated)"), {
    target: { value: "US citizen, EU blue card" },
  });
  fireEvent.change(screen.getByLabelText("Sponsorship required"), { target: { value: "yes" } });
  fireEvent.change(screen.getByLabelText("Years of experience"), { target: { value: "11" } });
  fireEvent.change(screen.getByLabelText("Salary min"), { target: { value: "170000" } });
  fireEvent.change(screen.getByLabelText("Salary target"), { target: { value: "210000" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Profile" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(/career profile .* created/i),
  );
  const call = fetchMock.mock.calls.find(
    ([url, init]) =>
      url === "/api/settings/profiles" &&
      (init as { method?: string } | undefined)?.method === "POST",
  ) as [string, { body: string } | undefined] | undefined;
  expect(call).toBeDefined();
  expect(JSON.parse(call?.[1]?.body ?? "{}")).toEqual({
    name: "data-lead",
    displayName: "Data Lead",
    workPreferences: {
      workAuthorization: ["US citizen", "EU blue card"],
      workMode: ["REMOTE", "HYBRID"],
      sponsorshipRequired: true,
      willingToRelocate: false,
      targetTitles: [],
      targetLocations: [],
      yearsOfExperience: 11,
      salaryExpectation: { min: 170000, target: 210000 },
    },
  });
});

it("edits preferences on an existing profile with prefilled values", async () => {
  const { fetchMock } = setupProfiles({
    profiles: profileSummaries,
    onWrite: (url) =>
      url === "/api/settings/profiles/profile-1"
        ? { profile: { ...profileSummaries[0], displayName: "Staff Engineer II" } }
        : undefined,
  });
  await waitFor(() => expect(screen.getByText("Staff Engineer")).toBeVisible());
  fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0] as HTMLElement);
  expect(screen.getByLabelText("Display name")).toHaveValue("Staff Engineer");
  expect(screen.getByLabelText("Remote")).toBeChecked();
  expect(screen.getByLabelText("Work authorization (comma-separated)")).toHaveValue("US citizen");
  fireEvent.change(screen.getByLabelText("Display name"), {
    target: { value: "Staff Engineer II" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(/career profile .* updated/i),
  );
  const call = fetchMock.mock.calls.find(
    ([url, init]) =>
      url === "/api/settings/profiles/profile-1" &&
      (init as { method?: string } | undefined)?.method === "PATCH",
  ) as [string, { body: string } | undefined] | undefined;
  expect(call).toBeDefined();
  const body = JSON.parse(call?.[1]?.body ?? "{}") as Record<string, unknown>;
  expect(body["displayName"]).toBe("Staff Engineer II");
  expect(body["workPreferences"]).toMatchObject({
    workAuthorization: ["US citizen"],
    workMode: ["REMOTE"],
    yearsOfExperience: 9,
  });
  expect(body["executiveNarrative"]).toBe("Platform narrative.");
});

it("rejects a non-JSON master resume upload with a validation error", async () => {
  setupProfiles({ profiles: profileSummaries });
  await waitFor(() => expect(screen.getByText("Staff Engineer")).toBeVisible());
  const input = document.getElementById("settings-resume-file") as HTMLInputElement;
  const file = new File(["not json {{{ "], "bad.json", { type: "application/json" });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(/is not valid JSON/i),
  );
});

it("uploads a master resume and re-syncs it", async () => {
  const { fetchMock } = setupProfiles({
    profiles: profileSummaries,
    onWrite: (url) =>
      url === "/api/settings/master-resume"
        ? { ok: true, versionId: "v3", version: 3, activated: true, alreadyCurrent: false }
        : undefined,
  });
  await waitFor(() => expect(screen.getByText("Staff Engineer")).toBeVisible());
  const input = document.getElementById("settings-resume-file") as HTMLInputElement;
  const file = new File(['{"achievements":[]}'], "master-resume.json", {
    type: "application/json",
  });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(/re-synced to version 3/i),
  );
  const call = fetchMock.mock.calls.find(
    ([url, init]) =>
      url === "/api/settings/master-resume" &&
      (init as { method?: string } | undefined)?.method === "POST",
  ) as [string, { body: string } | undefined] | undefined;
  expect(call).toBeDefined();
  expect(JSON.parse(call?.[1]?.body ?? "{}")).toEqual({ content: { achievements: [] } });
});

it("resets section scroll to the top when switching tabs", async () => {
  setup();
  await waitFor(() => expect(screen.getByRole("tab", { name: "Data & Backup" })).toHaveAttribute("aria-selected", "true"));
  const scroller = document.querySelector(".settings-scroll") as HTMLElement;
  scroller.scrollTop = 300;
  selectTab("AI & Models");
  expect(scroller.scrollTop).toBe(0);
});
