/**
 * <AppShell> — persistent layout shell mounted once in the root layout.
 * Sidebar and Taskbar stay mounted across page navigations.
 * Individual pages just render their content windows into the content area.
 */
import type { ReactNode } from "react";
import { Taskbar } from "./Taskbar";
import { Sidebar } from "./Sidebar";

export function AppShell({ children }: { children: ReactNode }) {
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
