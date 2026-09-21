import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import SettingsModal from "../../../../components/settings/SettingsModal";

const providerChains = {
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
};

const snapshot = {
  models: { primary: "provider/primary", fallback: "provider/fallback" },
  activeProvider: "openrouter",
  providers: providerChains,
  savedProvider: "openrouter",
  saved: { exists: true, provider: "openrouter", providers: providerChains },
  restartNeeded: false,
  restartDetail: null,
  worker: null,
  workerMatch: null,
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
      careerKeywords: [],
    },
    executiveNarrative: "Platform narrative.",
    versionCount: 2,
    latestVersion: 2,
    latestVersionAt: "2026-09-01T12:00:00.000Z",
    activeVersion: 2,
    approvedFacts: 5,
    activeSource: null,
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
    activeSource: null,
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
          json: async () => ({ primary: "p", fallback: "f", savedProvider: "openrouter", restartRequired: true }),
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
      expect(screen.getByRole("status")).toHaveTextContent(/OpenRouter saved.*restart/i),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save Models" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/OpenRouter saved.*restart/i),
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
  const fetchMock = mockFetch({
    onWrite: (url) =>
      url === "/api/settings/model"
        ? { primary: "gemini-2.5-pro", fallback: "gemini-2.5-flash", savedProvider: "google", restartRequired: true }
        : undefined,
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SettingsModal open onOpenChange={() => {}} />);
  selectTab("AI & Models");
  await waitFor(() =>
    expect(screen.getByLabelText("Primary model")).toHaveValue("provider/primary"),
  );
  expect(screen.getByRole("radio", { name: /Google AI Studio/ })).toHaveTextContent(
    "Configured · abc12345",
  );
  expect(screen.getByRole("radio", { name: /Meta Muse/ })).toHaveTextContent("Key missing");
  fireEvent.click(screen.getByRole("radio", { name: /Google AI Studio/ }));
  expect(screen.getByRole("radio", { name: /Google AI Studio/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(screen.getByLabelText("Primary model")).toHaveValue("gemini-2.5-pro");
  expect(screen.getByLabelText("Fallback model")).toHaveValue("gemini-2.5-flash");
  fireEvent.click(screen.getByRole("button", { name: "Save Models" }));
  await waitFor(() =>
    expect(screen.getByText(/Google AI Studio saved.*restart/i)).toBeInTheDocument(),
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

it("tests the entered draft models and shows the tested model", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/settings/ai-test") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          model: "gemini-2.5-pro",
          latencyMs: 342,
          error: null,
          provider: "google",
          testedModel: "gemini-2.5-pro",
          keySource: "stored",
          reasonCode: "ok",
          action: null,
          fallback: null,
        }),
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
    expect(screen.getByRole("group", { name: "Connection test result" })).toHaveTextContent(
      /Test passed.*gemini-2.5-pro.*stored key, nothing saved/,
    ),
  );
  const pingPost = fetchMock.mock.calls.find(
    ([url]) => url === "/api/settings/ai-test",
  ) as [string, { body: string } | undefined] | undefined;
  expect(JSON.parse(pingPost?.[1]?.body ?? "{}")).toEqual({
    provider: "google",
    model: "gemini-2.5-pro",
    fallbackModel: "gemini-2.5-flash",
  });
});

it("keeps the saved selection when it differs from the running provider", async () => {
  // Reported regression: OpenRouter saved while Google runs — the form
  // must open on the saved OpenRouter draft, not revert to Google.
  const diverged = {
    ...snapshot,
    activeProvider: "google",
    savedProvider: "openrouter",
    saved: { exists: true, provider: "openrouter", providers: providerChains },
    restartNeeded: true,
    restartDetail: "saved provider is OpenRouter but the web process is running Google AI Studio",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/settings/profiles") {
        return { ok: true, status: 200, json: async () => ({ profiles: [] }) };
      }
      return { ok: true, status: 200, json: async () => diverged };
    }),
  );
  render(<SettingsModal open onOpenChange={() => {}} />);
  selectTab("AI & Models");
  await waitFor(() =>
    expect(screen.getByLabelText("Primary model")).toHaveValue("provider/primary"),
  );
  expect(screen.getByRole("radio", { name: /OpenRouter/ })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("radio", { name: /OpenRouter/ })).toHaveTextContent("Saved");
  expect(screen.getByRole("radio", { name: /Google AI Studio/ })).toHaveTextContent("Active");
  expect(screen.getByRole("note", { name: "Restart required" })).toHaveTextContent(
    /OpenRouter saved — restart required/,
  );
});

it("invalidates the test result when a tested input changes", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/settings/ai-test") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          model: "provider/primary",
          latencyMs: 12,
          error: null,
          testedModel: "provider/primary",
          keySource: "stored",
          reasonCode: "ok",
          action: null,
          fallback: null,
        }),
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
  fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
  await waitFor(() =>
    expect(screen.getByRole("group", { name: "Connection test result" })).toBeInTheDocument(),
  );
  fireEvent.change(screen.getByLabelText("Primary model"), { target: { value: "provider/edited" } });
  expect(screen.queryByRole("group", { name: "Connection test result" })).toBeNull();
});

it("saves and removes keys write-only with explicit removal", async () => {
  const { fetchMock } = setupProfiles({
    profiles: [],
    onWrite: (url) =>
      url === "/api/settings/keys"
        ? { provider: "openrouter", configured: true, changed: true, message: "OpenRouter key saved." }
        : undefined,
  });
  selectTab("AI & Models");
  await waitFor(() =>
    expect(screen.getByLabelText(/API key for OpenRouter/)).toBeInTheDocument(),
  );
  fireEvent.change(screen.getByLabelText(/API key for OpenRouter/), {
    target: { value: "typed-synthetic-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save Key" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(/OpenRouter key saved/),
  );
  const savePost = fetchMock.mock.calls.find(
    ([url]) => url === "/api/settings/keys",
  ) as [string, { body: string } | undefined] | undefined;
  expect(JSON.parse(savePost?.[1]?.body ?? "{}")).toEqual({
    provider: "openrouter",
    key: "typed-synthetic-key",
  });
  // Key field clears after save; removal needs two clicks.
  expect(screen.getByLabelText(/API key for OpenRouter/)).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Remove Key" }));
  expect(screen.getByRole("button", { name: "Confirm Remove" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Confirm Remove" }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/settings/keys"),
    ).toHaveLength(2),
  );
  const removePost = fetchMock.mock.calls.filter(
    ([url]) => url === "/api/settings/keys",
  )[1] as [string, { body: string } | undefined];
  expect(JSON.parse(removePost?.[1]?.body ?? "{}")).toEqual({
    provider: "openrouter",
    remove: true,
  });
});

it("sends a transient key with the draft test and preserves input on failure", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/settings/ai-test") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: false,
          model: "provider/draft",
          latencyMs: 50,
          error: "OpenRouter returned HTTP 502: a service-side error.",
          provider: "openrouter",
          testedModel: "provider/draft",
          keySource: "transient",
          reasonCode: "server",
          action: "Retry the test shortly.",
          fallback: null,
        }),
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
  fireEvent.change(screen.getByLabelText("Primary model"), { target: { value: "provider/draft" } });
  fireEvent.change(screen.getByLabelText(/API key for OpenRouter/), {
    target: { value: "transient-draft-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
  await waitFor(() =>
    expect(screen.getByRole("group", { name: "Connection test result" })).toHaveTextContent(
    /Test failed.*502.*Retry the test shortly/,
    ),
  );
  const pingPost = fetchMock.mock.calls.find(
    ([url]) => url === "/api/settings/ai-test",
  ) as [string, { body: string } | undefined] | undefined;
  expect(JSON.parse(pingPost?.[1]?.body ?? "{}")).toMatchObject({
    provider: "openrouter",
    model: "provider/draft",
    apiKey: "transient-draft-key",
  });
  // Failure preserves every entered input.
  expect(screen.getByLabelText("Primary model")).toHaveValue("provider/draft");
  expect(screen.getByLabelText(/API key for OpenRouter/)).toHaveValue("transient-draft-key");
});

it("renders career profiles with readiness, setup actions, and legacy metadata", async () => {
  setupProfiles({ profiles: profileSummaries });
  await waitFor(() => expect(screen.getByText("Staff Engineer")).toBeVisible());
  expect(screen.getByText("Engineering Manager")).toBeVisible();
  expect(screen.getByText("Default")).toBeVisible();
  expect(screen.getByText(/staff-engineer · 2 versions · 5 facts/)).toHaveTextContent(
    "active v2",
  );
  expect(screen.getByRole("button", { name: "Set Default" })).toBeVisible();
  expect(screen.getAllByRole("button", { name: "Set up" })).toHaveLength(2);
  // Per-profile readiness with its next action, independent of the default.
  expect(screen.getByText(/Active master v2/)).toBeVisible();
  expect(screen.getByText(/No master yet/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Start empty" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Create from existing profile" })).toBeVisible();
  // Legacy-file status stays visible; per-profile exports live in workspaces.
  expect(screen.getByText("Test candidate")).toBeVisible();
  expect(screen.getByRole("button", { name: "Re-sync Master Resume" })).toBeVisible();
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

it("creates an empty career profile and opens its setup workspace", async () => {
  const { fetchMock } = setupProfiles({
    profiles: [],
    onWrite: (url) =>
      url === "/api/settings/profiles"
        ? { profile: { ...profileSummaries[1], id: "profile-9" } }
        : undefined,
  });
  await waitFor(() => expect(screen.getByText(/no career profiles yet/i)).toBeVisible());
  fireEvent.click(screen.getByRole("button", { name: "Start empty" }));
  fireEvent.change(screen.getByLabelText("Name (slug)"), { target: { value: "data-lead" } });
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Data Lead" } });
  fireEvent.click(screen.getByRole("button", { name: "Create empty profile" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(/created empty/i),
  );
  const call = fetchMock.mock.calls.find(
    ([url, init]) =>
      url === "/api/settings/profiles" &&
      (init as { method?: string } | undefined)?.method === "POST",
  ) as [string, { body: string } | undefined] | undefined;
  expect(call).toBeDefined();
  // Start-empty posts identity only; preferences/master setup continues below.
  expect(JSON.parse(call?.[1]?.body ?? "{}")).toEqual({
    name: "data-lead",
    displayName: "Data Lead",
  });
});

it("edits preferences in a setup workspace with prefilled values", async () => {
  const { fetchMock } = setupProfiles({
    profiles: profileSummaries,
    onWrite: (url) =>
      url === "/api/settings/profiles/profile-1"
        ? { profile: { ...profileSummaries[0], displayName: "Staff Engineer II" } }
        : undefined,
  });
  await waitFor(() => expect(screen.getByText("Staff Engineer")).toBeVisible());
  fireEvent.click(screen.getAllByRole("button", { name: "Set up" })[0] as HTMLElement);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save preferences" })).toBeVisible(),
  );
  const prefs = screen.getByRole("region", { name: "Preferences" });
  expect(
    (prefs as HTMLElement).querySelector("#prefs-profile-1-display"),
  ).toHaveValue("Staff Engineer");
  fireEvent.change((prefs as HTMLElement).querySelector("#prefs-profile-1-display") as HTMLElement, {
    target: { value: "Staff Engineer II" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(/preferences for .* saved/i),
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

it("guards workspace switches when edits are unsaved", async () => {
  setupProfiles({ profiles: profileSummaries });
  await waitFor(() => expect(screen.getByText("Staff Engineer")).toBeVisible());
  fireEvent.click(screen.getAllByRole("button", { name: "Set up" })[0] as HTMLElement);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save preferences" })).toBeVisible(),
  );
  fireEvent.change(document.getElementById("prefs-profile-1-display") as HTMLElement, {
    target: { value: "Staff Engineer II" },
  });
  // The open workspace's own button reads "Close setup"; one "Set up" remains.
  fireEvent.click(screen.getByRole("button", { name: "Set up" }));
  expect(screen.getByText(/unsaved changes\. Discard them and switch/i)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(
    (document.getElementById("prefs-profile-1-display") as HTMLInputElement).value,
  ).toBe("Staff Engineer II");
  fireEvent.click(screen.getByRole("button", { name: "Set up" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  await waitFor(() =>
    expect(document.getElementById("prefs-profile-2-display")).toBeVisible(),
  );
});

it("rejects pasted non-JSON in onboarding while preserving the text", async () => {
  setupProfiles({ profiles: profileSummaries });
  await waitFor(() => expect(screen.getByText("Staff Engineer")).toBeVisible());
  fireEvent.click(screen.getAllByRole("button", { name: "Set up" })[0] as HTMLElement);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "JSON upload / paste" })).toBeVisible(),
  );
  fireEvent.click(screen.getByRole("button", { name: "JSON upload / paste" }));
  const box = document.getElementById("onboard-profile-1-json") as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "not json {{{ " } });
  fireEvent.click(screen.getByRole("button", { name: "Validate & preview" }));
  expect(screen.getByText(/not valid JSON/)).toBeVisible();
  expect((document.getElementById("onboard-profile-1-json") as HTMLTextAreaElement).value).toBe(
    "not json {{{ ",
  );
});

it("validates then explicitly activates an onboarded master per profile", async () => {
  const { fetchMock } = setupProfiles({
    profiles: profileSummaries,
    onWrite: (url) => {
      if (url === "/api/settings/master-resume/parse") {
        return {
          ok: true,
          payload: {
            identity: { fullName: "Casey Doe" },
            targetTitles: [],
            targetLocations: [],
            employment: [],
            achievements: [],
            skills: [],
            languages: [],
            education: [],
            credentials: [],
          },
          summary: {
            employments: 0,
            achievements: 0,
            approvedAchievements: 0,
            pendingAchievements: 0,
            skills: 0,
            verifiedSkills: 0,
            languages: 0,
            education: 0,
            credentials: 0,
          },
        };
      }
      if (url === "/api/settings/master-resume") {
        return { ok: true, versionId: "v3", version: 3, activated: true, alreadyCurrent: false };
      }
      return undefined;
    },
  });
  await waitFor(() => expect(screen.getByText("Engineering Manager")).toBeVisible());
  // Second profile: setup never touches the default.
  fireEvent.click(screen.getAllByRole("button", { name: "Set up" })[1] as HTMLElement);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "JSON upload / paste" })).toBeVisible(),
  );
  fireEvent.click(screen.getByRole("button", { name: "JSON upload / paste" }));
  fireEvent.change(document.getElementById("onboard-profile-2-json") as HTMLElement, {
    target: { value: '{"identity":{"fullName":"Casey Doe"}}' },
  });
  fireEvent.click(screen.getByRole("button", { name: "Validate & preview" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Review and activate master" })).toBeVisible(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Review and activate master" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(/reviewed and activated as version 3/i),
  );
  const call = fetchMock.mock.calls.find(
    ([url, init]) =>
      url === "/api/settings/master-resume" &&
      (init as { method?: string } | undefined)?.method === "POST",
  ) as [string, { body: string } | undefined] | undefined;
  expect(call).toBeDefined();
  expect(JSON.parse(call?.[1]?.body ?? "{}")).toMatchObject({
    profileId: "profile-2",
    activate: true,
  });
});

it("opens a deep-linked profile workspace from an open request", async () => {
  const fetchMock = mockFetch({ profiles: profileSummaries });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <SettingsModal
      open
      onOpenChange={() => {}}
      openRequest={{ tab: "profile", profileId: "profile-2", seq: 1 }}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "Candidate Profile" })).toHaveAttribute(
      "aria-selected",
      "true",
    ),
  );
  await waitFor(() =>
    expect(document.getElementById("prefs-profile-2-display")).toBeVisible(),
  );
});

it("resets section scroll to the top when switching tabs", async () => {
  setup();
  await waitFor(() => expect(screen.getByRole("tab", { name: "Data & Backup" })).toHaveAttribute("aria-selected", "true"));
  const scroller = document.querySelector(".settings-scroll") as HTMLElement;
  scroller.scrollTop = 300;
  selectTab("AI & Models");
  expect(scroller.scrollTop).toBe(0);
});
