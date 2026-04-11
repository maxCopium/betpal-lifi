"use client";

/**
 * <DraggableWindow> — a 98.css window that can be dragged by its title bar,
 * minimized to the taskbar, and restored.
 *
 * Uses pointer events for drag (no external libs). Registers itself with
 * the WindowManager context for taskbar integration.
 */
import {
  useRef,
  useEffect,
  useCallback,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useWindowManager } from "./WindowManager";

export type DraggableWindowProps = {
  id: string;
  title: string;
  children: ReactNode;
  /** Initial position offset from natural flow (default: 0,0) */
  defaultPosition?: { x: number; y: number };
  /** Fixed width in px (optional — defaults to 100% like betpal-window) */
  width?: number;
  bodyClassName?: string;
  /** If true, window cannot be closed (only minimized) */
  noClose?: boolean;
};

export function DraggableWindow({
  id,
  title,
  children,
  defaultPosition,
  width,
  bodyClassName,
  noClose = true,
}: DraggableWindowProps) {
  const wm = useWindowManager();
  const elRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(defaultPosition ?? { x: 0, y: 0 });
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // Register/unregister with window manager
  useEffect(() => {
    wm.register(id, title);
    return () => wm.unregister(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, title]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Only drag from title bar itself, not buttons
      if ((e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      wm.focus(id);
      dragState.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: pos.x,
        origY: pos.y,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [id, pos, wm],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragState.current) return;
      const dx = e.clientX - dragState.current.startX;
      const dy = e.clientY - dragState.current.startY;
      setPos({
        x: dragState.current.origX + dx,
        y: dragState.current.origY + dy,
      });
    },
    [],
  );

  const onPointerUp = useCallback(() => {
    dragState.current = null;
  }, []);

  const minimized = wm.isMinimized(id);
  const zIndex = wm.getZIndex(id);

  if (minimized) return null;

  return (
    <div
      ref={elRef}
      className="window betpal-draggable-window"
      style={{
        transform: `translate(${pos.x}px, ${pos.y}px)`,
        zIndex,
        width: width ?? undefined,
        position: "relative",
      }}
      onPointerDown={() => wm.focus(id)}
    >
      <div
        className="title-bar"
        style={{ cursor: "grab", userSelect: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div className="title-bar-text">{title}</div>
        <div className="title-bar-controls">
          <button aria-label="Minimize" onClick={() => wm.minimize(id)} />
          <button aria-label="Maximize" />
          {!noClose && <button aria-label="Close" />}
        </div>
      </div>
      <div className={`window-body ${bodyClassName ?? ""}`}>{children}</div>
    </div>
  );
}
