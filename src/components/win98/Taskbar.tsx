"use client";

/**
 * <Taskbar> — pinned bottom strip with a Start button + clock.
 * Clock updates client-side; render placeholder until mounted to avoid hydration drift.
 */
import { useEffect, useState } from "react";

function formatClock(d: Date) {
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

export function Taskbar() {
  const [now, setNow] = useState<string | null>(null);

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
      <div className="betpal-clock">{now ?? "--:-- --"}</div>
    </div>
  );
}
