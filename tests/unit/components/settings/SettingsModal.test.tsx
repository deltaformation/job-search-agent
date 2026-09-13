import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import SettingsModal from "../../../../components/settings/SettingsModal";

const snapshot = {
  models: { primary: "provider/primary", fallback: "provider/fallback" },
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

it("resets section scroll to the top when switching tabs", async () => {
  setup();
  await waitFor(() => expect(screen.getByRole("tab", { name: "Data & Backup" })).toHaveAttribute("aria-selected", "true"));
  const scroller = document.querySelector(".settings-scroll") as HTMLElement;
  scroller.scrollTop = 300;
  selectTab("AI & Models");
  expect(scroller.scrollTop).toBe(0);
});
