"use client";

import { useEffect, useRef } from "react";

/**
 * Accessible modal shell for dialogs and the card drawer: moves focus in
 * on open, traps Tab inside, closes on Escape or overlay click, and
 * returns focus to the opener on unmount.
 */

interface DialogProps {
  labelledBy: string;
  onClose: () => void;
  position: "center" | "right" | "workspace";
  children: React.ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export default function Dialog({ labelledBy, onClose, position, children }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    openerRef.current = document.activeElement;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      const opener = openerRef.current;
      if (opener instanceof HTMLElement) {
        opener.focus();
      }
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== panelRef.current) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || panelRef.current === null) {
        return;
      }
      const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (items.length === 0) {
        return;
      }
      const firstItem = items[0] as HTMLElement;
      const lastItem = items[items.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex justify-end"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={
          position === "workspace"
            ? "workspace-panel relative flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-background px-4 py-5 sm:px-6 lg:px-8 text-foreground"
            : position === "right"
            ? "dialog-panel-right relative h-full w-full max-w-2xl overflow-y-auto border-l border-border bg-background p-6 shadow-2xl text-foreground"
            : "dialog-panel-center mx-auto my-auto w-full max-h-[90dvh] overflow-y-auto max-w-lg rounded-xl border border-border bg-background p-6 shadow-2xl text-foreground"
        }
      >
        {children}
      </div>
    </div>
  );
}
