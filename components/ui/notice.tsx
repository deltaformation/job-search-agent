"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared notification banner (Phase 1.4): success confirmations
 * auto-dismiss after 3.5s; errors, conflicts, and warnings persist until
 * the user dismisses them. Every banner carries an explicit [X] so
 * keyboard and mouse users can clear it immediately.
 *
 * Parents remount per notice (`key={notice.seq}`) so each new notice —
 * even one identical to the last — restarts the timer with no leaks:
 * the timeout clears on replacement and on unmount.
 */

export const NOTICE_AUTO_DISMISS_MS = 3500;
/** Re-check cadence while focus sits inside a notice whose timer fired. */
const NOTICE_FOCUS_DEFER_MS = 1000;

export type NoticeVariant = "success" | "error";

export interface TimedNotice<T> {
  data: T;
  /** Monotonic identity: use as the banner's React key. */
  seq: number;
}

export function useNotice<T>(): {
  notice: TimedNotice<T> | null;
  show: (data: T) => void;
  clear: () => void;
} {
  const [notice, setNotice] = useState<TimedNotice<T> | null>(null);
  const seqRef = useRef(0);
  const show = useCallback((data: T) => {
    seqRef.current += 1;
    setNotice({ data, seq: seqRef.current });
  }, []);
  const clear = useCallback(() => setNotice(null), []);
  return { notice, show, clear };
}

interface NoticeProps {
  variant: NoticeVariant;
  onDismiss: () => void;
  /**
   * Auto-dismiss delay; `null` persists until manual dismiss. Defaults to
   * 3.5s for success and persistent for errors — errors must never pass
   * a delay.
   */
  dismissAfterMs?: number | null;
  testId?: string;
  className?: string;
  children: React.ReactNode;
}

export function Notice({
  variant,
  onDismiss,
  dismissAfterMs,
  testId,
  className,
  children,
}: NoticeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const effectiveDelay =
    dismissAfterMs === undefined
      ? variant === "success"
        ? NOTICE_AUTO_DISMISS_MS
        : null
      : dismissAfterMs;

  useEffect(() => {
    if (effectiveDelay === null) {
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      // Never strand keyboard focus: while focus sits inside the banner
      // (link, dismiss button), defer dismissal instead of dropping
      // focus to <body> mid-interaction.
      if (ref.current?.contains(document.activeElement) === true) {
        timer = setTimeout(tick, NOTICE_FOCUS_DEFER_MS);
      } else {
        onDismiss();
      }
    };
    timer = setTimeout(tick, effectiveDelay);
    return () => clearTimeout(timer);
  }, [effectiveDelay, onDismiss]);

  return (
    <div
      ref={ref}
      role={variant === "success" ? "status" : "alert"}
      aria-live={variant === "success" ? "polite" : "assertive"}
      data-testid={testId}
      className={cn("flash-enter flex items-start justify-between gap-3", className)}
    >
      <div className="min-w-0 flex-1">{children}</div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="shrink-0 cursor-pointer rounded p-1 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
