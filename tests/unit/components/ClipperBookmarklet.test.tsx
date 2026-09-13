import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClipperBookmarklet, {
  buildBookmarklet,
} from "../../../components/ClipperBookmarklet";

describe("buildBookmarklet", () => {
  it("builds an executable javascript link posting the DOM", () => {
    const href = buildBookmarklet("http://127.0.0.1:3000", "t".repeat(64));
    expect(href.startsWith("javascript:")).toBe(true);
    expect(href).not.toContain(" ");
    expect(href).not.toContain("#");
    const code = decodeURIComponent(href.slice("javascript:".length));
    expect(() => new Function(code)).not.toThrow();
    expect(code).toContain("http://127.0.0.1:3000/api/intake/clip");
    expect(code).toContain(`Bearer ${"t".repeat(64)}`);
    expect(code).toContain("document.documentElement.outerHTML");
    expect(code).toContain("location.href");
  });
});

describe("ClipperBookmarklet", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders a draggable personalized bookmarklet with the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ token: "a".repeat(64) }),
      }),
    );
    render(<ClipperBookmarklet />);
    expect(await screen.findByText("1-click browser clipper")).toBeInTheDocument();
    const link = await screen.findByRole("link", { name: "Clip to Job Tracker" });
    const href = link.getAttribute("href") ?? "";
    expect(href.startsWith("javascript:")).toBe(true);
    expect(decodeURIComponent(href)).toContain(`Bearer ${"a".repeat(64)}`);
    expect(decodeURIComponent(href)).toContain("/api/intake/clip");
    expect(screen.getByText("a".repeat(64))).toBeInTheDocument();
  });

  it("copies the token and announces load failures", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "b".repeat(64) }),
    }));
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const { unmount } = render(<ClipperBookmarklet />);
    fireEvent.click(await screen.findByRole("button", { name: /copy token/i }));
    expect(writeText).toHaveBeenCalledWith("b".repeat(64));
    expect(await screen.findByText("Copied.")).toBeInTheDocument();
    unmount();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "data root misconfigured" }),
    }));
    render(<ClipperBookmarklet />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "data root misconfigured",
    );
  });

  it("does not navigate when the bookmarklet is activated in place", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "c".repeat(64) }),
    }));
    render(<ClipperBookmarklet />);
    const link = await screen.findByRole("link", { name: "Clip to Job Tracker" });
    // Drag-only control: activating it in place must not clip this page
    // or jump to the placeholder hash.
    expect(fireEvent.click(link)).toBe(false);
  });

  it("refuses to render the bookmarklet for malformed tokens", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "not-hex" }),
    }));
    render(<ClipperBookmarklet />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "unexpected token shape",
    );
    expect(
      screen.queryByRole("link", { name: "Clip to Job Tracker" }),
    ).not.toBeInTheDocument();
  });
});
