/**
 * <Desktop> — page-level wrapper. Teal background, sidebar + content area,
 * pinned taskbar at the bottom. Win98 Explorer layout.
 */
import type { ReactNode } from "react";
import { Taskbar } from "./Taskbar";
import { Sidebar } from "./Sidebar";

export function Desktop({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="betpal-desktop">
        <Sidebar />
        <div className="betpal-content">{children}</div>
      </div>
      <Taskbar />
    </>
  );
}
