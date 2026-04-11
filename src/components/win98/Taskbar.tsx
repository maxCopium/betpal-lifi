"use client";

/**
 * <Taskbar> — pinned bottom strip with Start button, window buttons, clock,
 * and a mock-resolve button for demo purposes.
 */
import { useEffect, useState, useCallback } from "react";
import { useWindowManager } from "./WindowManager";
import { authedFetch } from "@/lib/clientFetch";

function formatClock(d: Date) {
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

type ActiveBet = {
  id: string;
  question: string;
  outcomes: string[];
  status: string;
};

export function Taskbar() {
  const [now, setNow] = useState<string | null>(null);
  const wm = useWindowManager();
  const [resolveOpen, setResolveOpen] = useState(false);
  const [bets, setBets] = useState<ActiveBet[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => setNow(formatClock(new Date()));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  const loadBets = useCallback(async () => {
    try {
      const res = await authedFetch<{ bets: ActiveBet[] }>("/api/bets/active");
      setBets(res.bets ?? []);
    } catch {
      setBets([]);
    }
  }, []);

  function toggleResolve() {
    if (!resolveOpen) loadBets();
    setResolveOpen(!resolveOpen);
  }

  async function mockResolve(betId: string, outcome: string) {
    setResolving(betId);
    try {
      await authedFetch(`/api/bets/${betId}/mock-resolve`, {
        method: "POST",
        body: JSON.stringify({ outcome }),
      });
      setBets((prev) => prev.filter((b) => b.id !== betId));
    } catch (e) {
      alert(`Resolve failed: ${(e as Error).message}`);
    } finally {
      setResolving(null);
    }
  }

  return (
    <div className="betpal-taskbar">
      <button style={{ fontWeight: 700, padding: "4px 14px", minHeight: 30 }}>
        Start
      </button>

      {/* Window buttons */}
      <div className="betpal-taskbar-windows">
        {wm.windows.map((w) => (
          <button
            key={w.id}
            className={`betpal-taskbar-btn ${w.minimized ? "" : "betpal-taskbar-btn--active"}`}
            onClick={() => (w.minimized ? wm.restore(w.id) : wm.minimize(w.id))}
            title={w.title}
          >
            {w.title.length > 22 ? w.title.slice(0, 20) + "…" : w.title}
          </button>
        ))}
      </div>

      {/* Mock resolve button */}
      <div style={{ position: "relative" }}>
        <button
          onClick={toggleResolve}
          title="Resolve mock bets"
          style={{ padding: "4px 10px" }}
        >
          Resolve
        </button>
        {resolveOpen && (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              right: 0,
              marginBottom: 6,
              width: 320,
              zIndex: 200,
            }}
          >
            <div className="window">
              <div className="title-bar">
                <div className="title-bar-text">Resolve Bets</div>
                <div className="title-bar-controls">
                  <button aria-label="Close" onClick={() => setResolveOpen(false)} />
                </div>
              </div>
              <div className="window-body" style={{ maxHeight: 320, overflowY: "auto" }}>
                {bets.length === 0 && (
                  <p style={{ opacity: 0.6, fontStyle: "italic" }}>No active mock bets.</p>
                )}
                {bets.map((bet) => (
                  <div key={bet.id} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid #dfdfdf" }}>
                    <strong style={{ display: "block", marginBottom: 6 }}>{bet.question}</strong>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {bet.outcomes.map((o) => (
                        <button
                          key={o}
                          disabled={resolving === bet.id}
                          onClick={() => mockResolve(bet.id, o)}
                          style={{ padding: "4px 12px" }}
                        >
                          {resolving === bet.id ? "…" : o}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="betpal-clock">{now ?? "--:-- --"}</div>
    </div>
  );
}
