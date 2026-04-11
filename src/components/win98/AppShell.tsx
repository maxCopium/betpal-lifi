"use client";

/**
 * <AppShell> — persistent layout shell mounted once in the root layout.
 * Sidebar and Taskbar stay mounted across page navigations.
 * Individual pages just render their content windows into the content area.
 * WindowManagerProvider enables draggable/minimizable windows + taskbar buttons.
 */
import type { ReactNode } from "react";
import { Taskbar } from "./Taskbar";
import { Sidebar } from "./Sidebar";
import { SidebarWallet } from "./SidebarWallet";
import { WindowManagerProvider } from "./WindowManager";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <WindowManagerProvider>
      <div className="betpal-desktop">
        <div className="betpal-left-column">
          <Sidebar />
          <SidebarWallet />
        </div>
        <div className="betpal-content">{children}</div>
      </div>
      <Taskbar />
    </WindowManagerProvider>
  );
}
