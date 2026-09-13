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
  profile: { activeVersion: 2, displayName: "Test candidate", approvedFacts: 5, verifiedSkills: 3 },
  storage: { databaseBytes: 100, walBytes: 0, jobCount: 4, evidenceBytes: 20, evidenceFiles: 1,
    artifactBytes: 30, artifactFiles: 3, backupCount: 0, backupsBytes: 0 },
};

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => snapshot });
  vi.stubGlobal("fetch", fetchMock);
  const onOpenChange = vi.fn();
  render(<SettingsModal open onOpenChange={onOpenChange} />);
  return { fetchMock, onOpenChange };
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
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/settings");
});

it("preserves the type-to-confirm reset gate when tabs are interrupted", async () => {
  const { fetchMock, onOpenChange } = setup();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
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
  expect(fetchMock).toHaveBeenCalledTimes(1);
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

it("resets section scroll to the top when switching tabs", async () => {
  setup();
  await waitFor(() => expect(screen.getByRole("tab", { name: "Data & Backup" })).toHaveAttribute("aria-selected", "true"));
  const scroller = document.querySelector(".settings-scroll") as HTMLElement;
  scroller.scrollTop = 300;
  selectTab("AI & Models");
  expect(scroller.scrollTop).toBe(0);
});
