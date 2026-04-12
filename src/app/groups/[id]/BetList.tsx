"use client";

/**
 * BetList — compact list of a group's bets, rendered inside the dashboard.
 *
 * Each row links to /bets/[id]. Stale auto-refresh on parent's `refreshKey`.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { authedFetch } from "@/lib/clientFetch";

type BetRow = {
  id: string;
  title: string;
  options: string[];
  polymarket_market_id: string;
  polymarket_url: string;
  join_deadline: string;
  status: string;
  resolution_outcome: string | null;
  created_at: string;
  live_prices: Record<string, number> | null;
};

function formatDeadline(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    ", " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

const STATUS_CLASS: Record<string, string> = {
  open: "betpal-status--info",
  locked: "betpal-status--warning",
  resolving: "betpal-status--warning",
  settled: "betpal-status--success",
  voided: "betpal-status--error",
};

export function BetList({
  groupId,
  refreshKey,
}: {
  groupId: string;
  refreshKey: number;
}) {
  const [bets, setBets] = useState<BetRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await authedFetch<{ bets: BetRow[] }>(
          `/api/groups/${groupId}/bets`,
        );
        if (!cancelled) setBets(data.bets);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groupId, refreshKey]);

  if (error) {
    return <div className="betpal-alert betpal-alert--error">{error}</div>;
  }
  if (bets === null) return <p style={{ opacity: 0.6 }}>Loading bets…</p>;
  if (bets.length === 0) return <p style={{ opacity: 0.6, fontStyle: "italic" }}>No bets yet.</p>;

  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
      {bets.map((b) => (
        <li key={b.id} className="betpal-list-item">
          <Link href={`/bets/${b.id}`} style={{ fontWeight: 500 }}>
            {b.title}
          </Link>
          <div style={{ marginTop: 4, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className={`betpal-status ${STATUS_CLASS[b.status] ?? "betpal-status--info"}`}>
              {b.status}
            </span>
            {b.resolution_outcome && (
              <span style={{ fontWeight: 600 }}>{b.resolution_outcome}</span>
            )}
            {b.live_prices && !b.resolution_outcome && (
              <span style={{ display: "inline-flex", gap: 4, fontSize: 11 }}>
                {b.options.map((o) => {
                  const p = b.live_prices?.[o];
                  if (p == null) return null;
                  const pct = Math.round(p * 100);
                  return (
                    <span
                      key={o}
                      style={{
                        padding: "1px 5px",
                        background: p >= 0.5 ? "#d4edda" : "#f0f0f0",
                        border: "1px solid #ccc",
                        fontWeight: p >= 0.5 ? 700 : 400,
                      }}
                    >
                      {o} {pct}%
                    </span>
                  );
                })}
              </span>
            )}
            <span style={{ opacity: 0.6 }}>
              join by {formatDeadline(b.join_deadline)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
