import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MasterOnboarding from "../../../../components/settings/MasterOnboarding";
import type { SettingsProfileSummary } from "../../../../components/settings/profiles";

/**
 * WO-1.2-C: onboarding validates without writing, preserves input
 * through every failure, previews the parsed document, and activates
 * only on the explicit review action.
 */

const profile: SettingsProfileSummary = {
  id: "profile-1",
  name: "pm",
  displayName: "Product Manager",
  isDefault: true,
  workPreferences: null,
  executiveNarrative: null,
  versionCount: 0,
  latestVersion: null,
  latestVersionAt: null,
  activeVersion: null,
  approvedFacts: 0,
  activeSource: null,
};

const parsedPayload = {
  identity: { fullName: "Alex Rivera", email: "alex@example.com" },
  targetTitles: [],
  targetLocations: [],
  summary: "Example summary.",
  employment: [],
  achievements: [],
  skills: [],
  languages: [{ name: "French", verified: false }],
  education: [],
  credentials: [],
};

const parsedSummary = {
  employments: 0,
  achievements: 0,
  approvedAchievements: 0,
  pendingAchievements: 0,
  skills: 0,
  verifiedSkills: 0,
  languages: 1,
  education: 0,
  credentials: 0,
};

afterEach(() => vi.unstubAllGlobals());

function setup(onRunImpl?: (action: string, fn: () => Promise<string>) => Promise<void>) {
  const onRun =
    onRunImpl ??
    (async (_action: string, fn: () => Promise<string>) => {
      await fn();
    });
  const onChanged = vi.fn(async () => {});
  render(
    <MasterOnboarding
      profile={profile}
      busy={null}
      onRun={onRun}
      onChanged={onChanged}
      onDirtyChange={() => {}}
    />,
  );
  return { onChanged };
}

describe("MasterOnboarding", () => {
  it("keeps pasted text when it is not valid JSON", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "JSON upload / paste" }));
    fireEvent.change(screen.getByLabelText("Master JSON (paste or loaded file)"), {
      target: { value: "not json {{{" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Validate & preview" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/not valid JSON/i);
    expect(screen.getByLabelText("Master JSON (paste or loaded file)")).toHaveValue("not json {{{");
  });

  it("shows field-level issues without writing and preserves content", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/settings/master-resume/parse") {
        // Real route shape: HTTP 422 with an {ok:false, issues} body.
        return {
          ok: false,
          status: 422,
          json: async () => ({
            ok: false,
            issues: [{ path: ["identity", "fullName"], message: "String must not be empty." }],
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    setup();
    fireEvent.click(screen.getByRole("button", { name: "JSON upload / paste" }));
    fireEvent.change(screen.getByLabelText("Master JSON (paste or loaded file)"), {
      target: { value: '{"identity":{}}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Validate & preview" }));
    await waitFor(() =>
      expect(screen.getByText(/1 validation issue/)).toBeVisible(),
    );
    expect(screen.getByText(/identity\.fullName/)).toBeVisible();
    expect(screen.getByLabelText("Master JSON (paste or loaded file)")).toHaveValue(
      '{"identity":{}}',
    );
    expect(screen.queryByRole("button", { name: "Review and activate master" })).toBeNull();
  });

  it("previews a valid document and activates it explicitly with the profile id", async () => {
    const bodies: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      bodies.push({ url, body: init?.body === undefined ? null : JSON.parse(init.body) });
      if (url === "/api/settings/master-resume/parse") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, payload: parsedPayload, summary: parsedSummary }),
        };
      }
      if (url === "/api/settings/master-resume") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            versionId: "v1",
            version: 1,
            activated: true,
            alreadyCurrent: false,
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { onChanged } = setup();
    fireEvent.click(screen.getByRole("button", { name: "JSON upload / paste" }));
    fireEvent.change(screen.getByLabelText("Master JSON (paste or loaded file)"), {
      target: { value: '{"identity":{"fullName":"Alex Rivera"}}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Validate & preview" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Review and activate master" }),
      ).toBeVisible(),
    );
    expect(screen.getByRole("heading", { name: "Alex Rivera" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Languages" })).toBeVisible();
    // Parse first, no import yet.
    expect(bodies.map((entry) => entry.url)).toEqual(["/api/settings/master-resume/parse"]);
    fireEvent.click(screen.getByRole("button", { name: "Review and activate master" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const upload = bodies.find((entry) => entry.url === "/api/settings/master-resume");
    expect(upload?.body).toMatchObject({ profileId: "profile-1", activate: true });
    expect((upload?.body as Record<string, unknown>)["content"]).toMatchObject({
      identity: { fullName: "Alex Rivera" },
    });
  });

  it("links the downloadable example", () => {
    setup();
    expect(screen.getByText("Download example")).toHaveAttribute(
      "href",
      "/examples/master-resume.json",
    );
  });
});
