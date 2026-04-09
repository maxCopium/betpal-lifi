/**
 * <Window> — a 98.css window frame.
 *
 * Renders a classic Win98 title bar + body. The body is a `.window-body`
 * styled by 98.css; we add `betpal-window` for layout sizing and let callers
 * pass Tailwind layout utilities via className for the body.
 */
import type { ReactNode } from "react";

export type WindowProps = {
  title: string;
  children: ReactNode;
  bodyClassName?: string;
  /** Show the classic min/max/close glyphs (decorative). */
  controls?: boolean;
};

export function Window({
  title,
  children,
  bodyClassName,
  controls = true,
}: WindowProps) {
  return (
    <div className="window betpal-window">
      <div className="title-bar">
        <div className="title-bar-text">{title}</div>
        {controls && (
          <div className="title-bar-controls">
            <button aria-label="Minimize" />
            <button aria-label="Maximize" />
            <button aria-label="Close" />
          </div>
        )}
      </div>
      <div className={`window-body ${bodyClassName ?? ""}`}>{children}</div>
    </div>
  );
}
