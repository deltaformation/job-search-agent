import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import CopyProfileForm from "../../../../components/settings/CopyProfileForm";
import type { SettingsProfileSummary } from "../../../../components/settings/profiles";

/** WO-1.2-C: create-from-existing always displays its source version. */

const profiles: SettingsProfileSummary[] = [
  {
    id: "profile-1",
    name: "pm",
    displayName: "Product Manager",
    isDefault: true,
    workPreferences: null,
    executiveNarrative: null,
    versionCount: 2,
    latestVersion: 2,
    latestVersionAt: "2026-09-12T00:00:00.000Z",
    activeVersion: 1,
    approvedFacts: 3,
    activeSource: null,
  },
];

const versions = [
  {
    id: "version-1",
    version: 1,
    createdAt: "2026-09-11T00:00:00.000Z",
    activatedAt: "2026-09-11T00:00:00.000Z",
    active: true,
    schemaVersion: "candidate-profile/v2",
    payloadHash: "ab".repeat(32),
    facts: { total: 3, approved: 3 },
    source: null,
  },
  {
    id: "version-2",
    version: 2,
    createdAt: "2026-09-12T00:00:00.000Z",
    activatedAt: null,
    active: false,
    schemaVersion: "candidate-profile/v2",
    payloadHash: "cd".repeat(32),
    facts: { total: 4, approved: 0 },
    source: null,
  },
];

afterEach(() => vi.unstubAllGlobals());

it("copies the displayed source version with an explicit version id", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url === "/api/settings/profiles/profile-1/versions") {
      return { ok: true, status: 200, json: async () => ({ versions }) };
    }
    if (url === "/api/settings/profiles/copy") {
      posts.push({ url, body: JSON.parse(init?.body ?? "{}") as unknown });
      return {
        ok: true,
        status: 201,
        json: async () => ({
          ok: true,
          profileId: "profile-2",
          versionId: "version-9",
          version: 1,
          copiedFacts: 4,
        }),
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const onCreated = vi.fn();
  render(
    <CopyProfileForm
      profiles={profiles}
      busy={null}
      onRun={async (_action, fn) => {
        await fn();
      }}
      onCreated={onCreated}
    />,
  );
  // Active version is the default source, drafts selectable.
  await waitFor(() =>
    expect(screen.getByLabelText("Source version")).toHaveValue("version-1"),
  );
  expect(screen.getByText(/Copying v1 \(active\)/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("Source version"), { target: { value: "version-2" } });
  expect(screen.getByText(/Copying v2 \(draft\)/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("Name (slug)"), { target: { value: "spm" } });
  fireEvent.change(screen.getByLabelText("Display name"), {
    target: { value: "Senior Product Manager" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create from existing" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("profile-2"));
  expect(posts).toHaveLength(1);
  expect(posts[0]?.body).toEqual({
    sourceProfileId: "profile-1",
    sourceVersionId: "version-2",
    name: "spm",
    displayName: "Senior Product Manager",
  });
});

it("explains when the source profile has no versions", async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ versions: [] }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <CopyProfileForm
      profiles={[{ ...profiles[0]!, versionCount: 0, latestVersion: null, activeVersion: null }]}
      busy={null}
      onRun={async (_action, fn) => {
        await fn();
      }}
      onCreated={() => {}}
    />,
  );
  await waitFor(() =>
    expect(screen.getByText(/has no versions — onboard a master there first/i)).toBeVisible(),
  );
  expect(screen.getByRole("button", { name: "Create from existing" })).toBeDisabled();
});
