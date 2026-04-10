/**
 * <Desktop> — legacy wrapper kept for backward compatibility.
 * The actual shell (sidebar + taskbar) is now in <AppShell> at root layout.
 * This component is a simple fragment passthrough.
 */
import type { ReactNode } from "react";

export function Desktop({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
