"use client";

/**
 * WindowManager — global state for Win98-style window management.
 *
 * Tracks which windows are open/minimized, their z-index stacking order,
 * and provides minimize/restore/focus/close actions.
 *
 * Used by DraggableWindow + Taskbar.
 */
import {
  createContext,
  useContext,
  useCallback,
  useState,
  type ReactNode,
} from "react";

export type WinState = {
  id: string;
  title: string;
  minimized: boolean;
  zIndex: number;
};

type WindowManagerCtx = {
  windows: WinState[];
  register: (id: string, title: string) => void;
  unregister: (id: string) => void;
  minimize: (id: string) => void;
  restore: (id: string) => void;
  focus: (id: string) => void;
  isMinimized: (id: string) => boolean;
  getZIndex: (id: string) => number;
};

const Ctx = createContext<WindowManagerCtx | null>(null);

export function useWindowManager() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWindowManager must be inside <WindowManagerProvider>");
  return ctx;
}

let nextZ = 10;

export function WindowManagerProvider({ children }: { children: ReactNode }) {
  const [windows, setWindows] = useState<WinState[]>([]);

  const register = useCallback((id: string, title: string) => {
    setWindows((prev) => {
      if (prev.find((w) => w.id === id)) return prev;
      return [...prev, { id, title, minimized: false, zIndex: ++nextZ }];
    });
  }, []);

  const unregister = useCallback((id: string) => {
    setWindows((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const minimize = useCallback((id: string) => {
    setWindows((prev) =>
      prev.map((w) => (w.id === id ? { ...w, minimized: true } : w)),
    );
  }, []);

  const restore = useCallback((id: string) => {
    setWindows((prev) =>
      prev.map((w) =>
        w.id === id ? { ...w, minimized: false, zIndex: ++nextZ } : w,
      ),
    );
  }, []);

  const focus = useCallback((id: string) => {
    setWindows((prev) =>
      prev.map((w) => (w.id === id ? { ...w, zIndex: ++nextZ } : w)),
    );
  }, []);

  const isMinimized = useCallback(
    (id: string) => windows.find((w) => w.id === id)?.minimized ?? false,
    [windows],
  );

  const getZIndex = useCallback(
    (id: string) => windows.find((w) => w.id === id)?.zIndex ?? 10,
    [windows],
  );

  return (
    <Ctx.Provider
      value={{ windows, register, unregister, minimize, restore, focus, isMinimized, getZIndex }}
    >
      {children}
    </Ctx.Provider>
  );
}
