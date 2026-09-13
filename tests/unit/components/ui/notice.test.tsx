import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NOTICE_AUTO_DISMISS_MS,
  Notice,
  useNotice,
  type NoticeVariant,
} from "../../../../components/ui/notice";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Mirrors the parent pattern exactly: hook-owned notice rendered through
 * a seq-keyed banner so every show() restarts the dismiss timer.
 */
function Harness({ variant }: { variant: NoticeVariant }) {
  const { notice, show, clear } = useNotice<string>();
  return (
    <div>
      <button type="button" onClick={() => show("Saved")}>
        show
      </button>
      {notice !== null && (
        <Notice key={notice.seq} variant={variant} onDismiss={clear}>
          {notice.data}
        </Notice>
      )}
    </div>
  );
}

describe("Notice", () => {
  it("auto-dismisses successes after 3.5s", () => {
    expect(NOTICE_AUTO_DISMISS_MS).toBe(3500);
    vi.useFakeTimers();
    render(<Harness variant="success" />);
    fireEvent.click(screen.getByRole("button", { name: "show" }));
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Saved");
    expect(banner).toHaveAttribute("aria-live", "polite");
    act(() => {
      vi.advanceTimersByTime(3499);
    });
    expect(screen.queryByRole("status")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps errors on screen past the success timeout", () => {
    vi.useFakeTimers();
    render(<Harness variant="error" />);
    fireEvent.click(screen.getByRole("button", { name: "show" }));
    const banner = screen.getByRole("alert");
    expect(banner).toHaveAttribute("aria-live", "assertive");
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Saved");
  });

  it("restarts the timer when an identical notice is shown again", () => {
    vi.useFakeTimers();
    render(<Harness variant="success" />);
    fireEvent.click(screen.getByRole("button", { name: "show" }));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // Same text, new notice: the old 3.5s deadline must not fire.
    fireEvent.click(screen.getByRole("button", { name: "show" }));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByRole("status")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("never fires after unmount", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { unmount } = render(
      <Notice variant="success" onDismiss={onDismiss}>
        Saved
      </Notice>,
    );
    unmount();
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("dismisses immediately from the [X] button on both variants", () => {
    for (const variant of ["success", "error"] as const) {
      const onDismiss = vi.fn();
      const { unmount } = render(
        <Notice variant={variant} onDismiss={onDismiss}>
          Saved
        </Notice>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
      expect(onDismiss).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("defers dismissal while focus sits inside the banner", () => {
    vi.useFakeTimers();
    render(<Harness variant="success" />);
    fireEvent.click(screen.getByRole("button", { name: "show" }));
    const dismiss = screen.getByRole("button", { name: "Dismiss notification" });
    dismiss.focus();
    expect(document.activeElement).toBe(dismiss);
    act(() => {
      vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS);
    });
    expect(screen.queryByRole("status")).toBeInTheDocument();
    dismiss.blur();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
