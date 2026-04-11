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
      // Remove from list after resolving.
      setBets((prev) => prev.filter((b) => b.id !== betId));
    } catch (e) {
      alert(`Resolve failed: ${(e as Error).message}`);
    } finally {
      setResolving(null);
    }
  }

  return (
    <div className="betpal-taskbar">
      <button style={{ fontWeight: 700, padding: "2px 10px" }}>
        Start
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

      {/* Mock resolve button — next to the clock */}
      <div style={{ position: "relative" }}>
        <button
          onClick={toggleResolve}
          title="Resolve mock bets"
          style={{ padding: "2px 6px", fontSize: 11 }}
        >
          Resolve
        </button>
        {resolveOpen && (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              right: 0,
              marginBottom: 4,
              width: 280,
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
              <div className="window-body" style={{ padding: 4, maxHeight: 300, overflowY: "auto" }}>
                {bets.length === 0 && (
                  <p style={{ fontSize: 11 }}>No active mock bets.</p>
                )}
                {bets.map((bet) => (
                  <div key={bet.id} style={{ marginBottom: 8, fontSize: 11 }}>
                    <strong>{bet.question}</strong>
                    <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
                      {bet.outcomes.map((o) => (
                        <button
                          key={o}
                          disabled={resolving === bet.id}
                          onClick={() => mockResolve(bet.id, o)}
                          style={{ fontSize: 11 }}
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
