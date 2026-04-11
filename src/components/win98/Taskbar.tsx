"use client";

/**
 * <Taskbar> — pinned bottom strip with Start button, window buttons, and clock.
 * Minimized windows appear as taskbar buttons. Click to restore.
 */
import { useEffect, useState } from "react";
import { useWindowManager } from "./WindowManager";

function formatClock(d: Date) {
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

export function Taskbar() {
  const [now, setNow] = useState<string | null>(null);
  const wm = useWindowManager();

  useEffect(() => {
    const tick = () => setNow(formatClock(new Date()));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="betpal-taskbar">
      <button style={{ fontWeight: 700, padding: "2px 10px" }}>
        🪟 Start
      </button>

      {/* Window buttons — all registered windows show here */}
      <div className="betpal-taskbar-windows">
        {wm.windows.map((w) => (
          <button
            key={w.id}
            className={`betpal-taskbar-btn ${w.minimized ? "" : "betpal-taskbar-btn--active"}`}
            onClick={() => (w.minimized ? wm.restore(w.id) : wm.minimize(w.id))}
            title={w.title}
          >
            {w.title.length > 18 ? w.title.slice(0, 16) + "…" : w.title}
          </button>
        ))}
      </div>

      <div className="betpal-clock">{now ?? "--:-- --"}</div>
    </div>
  );
}
