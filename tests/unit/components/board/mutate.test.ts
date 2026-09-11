import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../components/api";
import { postJobMutation } from "../../../../components/board/mutate";

describe("postJobMutation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("replays once with the fresh version after a conflict", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: "conflict", reason: "stale", currentRowVersion: 4 }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const result = await postJobMutation("/api/jobs/x/move", {
      to: "APPLIED",
      observedRowVersion: 2,
    });
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const replay = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(replay.observedRowVersion).toBe(4);
  });

  it("throws when the conflict carries no version or repeats", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: "conflict" }),
      }),
    );
    await expect(postJobMutation("/api/jobs/x/move", { observedRowVersion: 1 })).rejects.toThrow(
      ApiError,
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "forbidden" }),
      }),
    );
    await expect(postJobMutation("/api/jobs/x/move", { observedRowVersion: 1 })).rejects.toThrow(
      /forbidden/,
    );
  });
});
