"use client";

/**
 * CopyProgressDialog — Win98-flavored "Copying funds…" modal.
 *
 * Visual nod to the classic Windows file-copy dialog: animated progress bar,
 * a flying-papers banner, and a labelled status line. Used during the
 * deposit flow to make the cross-chain bridging feel like dragging files
 * between drives.
 *
 * Props:
 *   - open: whether to render the modal
 *   - title: title bar text
 *   - status: current short status (e.g. "Quoting route…", "Bridging…", "Done")
 *   - progress: 0..100; pass undefined for indeterminate (continuously cycling)
 *   - onCancel: optional cancel handler — only shown if provided
 *   - onClose: optional close handler — shown when progress === 100
 *
 * Layout uses Tailwind for positioning only (overlay, sizing). All chrome
 * comes from 98.css (.window, .title-bar, .progress-indicator).
 */
import { useEffect, useState } from "react";

export type CopyProgressDialogProps = {
  open: boolean;
  title?: string;
  status: string;
  /** 0..100. Undefined = indeterminate (auto-cycling fake progress). */
  progress?: number;
  fromLabel?: string;
  toLabel?: string;
  onCancel?: () => void;
  onClose?: () => void;
};

export function CopyProgressDialog({
  open,
  title = "Copying funds…",
  status,
  progress,
  fromLabel,
  toLabel,
  onCancel,
  onClose,
}: CopyProgressDialogProps) {
  // For indeterminate mode, cycle a fake bar so the user sees motion.
  const [fake, setFake] = useState(0);
  useEffect(() => {
    if (!open || progress !== undefined) return;
    const id = setInterval(() => setFake((f) => (f + 4) % 100), 120);
    return () => clearInterval(id);
  }, [open, progress]);

  if (!open) return null;
  const pct = progress ?? fake;
  const done = progress === 100;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.35)", zIndex: 50 }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="window" style={{ minWidth: 360, maxWidth: 480 }}>
        <div className="title-bar">
          <div className="title-bar-text">{title}</div>
          <div className="title-bar-controls">
            <button aria-label="Close" onClick={onClose} disabled={!done && !onClose} />
          </div>
        </div>
        <div className="window-body">
          <div className="flex flex-col gap-2">
            {/* Flying-papers banner — text-only ascii nod, since 98.css ships
                no bundled icons. */}
            <div
              className="text-center"
              style={{ fontFamily: "monospace", fontSize: 24, lineHeight: 1 }}
              aria-hidden="true"
            >
              📄 → 💾
            </div>
            <div className="text-xs">
              {fromLabel && toLabel ? (
                <>
                  From: <strong>{fromLabel}</strong>
                  <br />
                  To: <strong>{toLabel}</strong>
                </>
              ) : (
                status
              )}
            </div>
            <div className="progress-indicator segmented" style={{ width: "100%" }}>
              <span className="progress-indicator-bar" style={{ width: `${pct}%` }} />
            </div>
            <div className="text-xs">{status}</div>
            <div className="flex gap-2 justify-end">
              {onCancel && !done && (
                <button onClick={onCancel}>Cancel</button>
              )}
              {done && onClose && <button onClick={onClose}>Close</button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
