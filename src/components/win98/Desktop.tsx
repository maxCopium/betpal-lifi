/**
 * <Desktop> — page-level wrapper. Teal background, centered content column,
 * pinned taskbar at the bottom.
 */
import type { ReactNode } from "react";
import { Taskbar } from "./Taskbar";

export function Desktop({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="betpal-desktop">{children}</div>
      <Taskbar />
    </>
  );
}
