"use client";

/**
 * CopyProgressDialog — Win98-flavored "Copying funds…" modal.
 *
 * Visual nod to the classic Windows file-copy dialog: animated progress bar,
 * a flying-papers banner, and a labelled status line.
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
      <div className="window" style={{ minWidth: 340, maxWidth: 480, width: "92vw" }}>
        <div className="title-bar">
          <div className="title-bar-text">{title}</div>
          <div className="title-bar-controls">
            <button aria-label="Close" onClick={onClose} disabled={!done && !onClose} />
          </div>
        </div>
        <div className="window-body">
          <div className="flex flex-col gap-3">
            {/* Flying-papers banner */}
            <div
              className="text-center"
              style={{ fontFamily: "monospace", fontSize: 28, lineHeight: 1, padding: "8px 0" }}
              aria-hidden="true"
            >
              {done ? "✅" : "📄 → 💾"}
            </div>

            {fromLabel && toLabel && (
              <div style={{ lineHeight: 1.6 }}>
                From: <strong>{fromLabel}</strong>
                <br />
                To: <strong>{toLabel}</strong>
              </div>
            )}

            <div className="progress-indicator segmented" style={{ width: "100%" }}>
              <span className="progress-indicator-bar" style={{ width: `${pct}%` }} />
            </div>

            <div style={{ minHeight: 20 }}>{status}</div>

            <div className="flex gap-2 justify-end" style={{ paddingTop: 4 }}>
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
