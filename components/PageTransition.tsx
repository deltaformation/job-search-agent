"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Route-change fade: remounting on pathname replays the 150ms opacity
 * transition between pages. Opacity only (no slide), so route changes
 * never shift layout; reduced-motion users get no motion via the global
 * kill switch. Search-param updates keep the same key and do not replay.
 */
export default function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="page-enter">
      {children}
    </div>
  );
}
