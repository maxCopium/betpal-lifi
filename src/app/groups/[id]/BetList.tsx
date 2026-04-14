"use client";

/**
 * BetList — compact list of a group's bets, rendered inside the dashboard.
 *
 * Each row links to /bets/[id]. Stale auto-refresh on parent's `refreshKey`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { authedFetch } from "@/lib/clientFetch";

type BetRow = {
  id: string;
  title: string;
  options: string[];
  stake_amount_cents: number;
  polymarket_market_id: string;
  polymarket_url: string;
  join_deadline: string;
  status: string;
  resolution_outcome: string | null;
  created_at: string;
  live_prices: Record<string, number> | null;
  my_outcome: string | null;
  my_stake_cents: number;
  stakes_count: number;
  total_cents: number;
  winners_count: number;
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
  const [refreshing, setRefreshing] = useState(false);
  const lastRefresh = useRef(0);
  const COOLDOWN_MS = 60_000;

  const fetchBets = useCallback(async () => {
    try {
      const data = await authedFetch<{ bets: BetRow[] }>(
        `/api/groups/${groupId}/bets`,
      );
      setBets(data.bets);
      lastRefresh.current = Date.now();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [groupId]);

  useEffect(() => {
    let cancelled = false;
    fetchBets().finally(() => { if (cancelled) return; });
    return () => { cancelled = true; };
  }, [fetchBets, refreshKey]);

  async function handleRefresh() {
    const elapsed = Date.now() - lastRefresh.current;
    if (elapsed < COOLDOWN_MS) return;
    setRefreshing(true);
    await fetchBets();
    setRefreshing(false);
  }

  const cooldownActive = Date.now() - lastRefresh.current < COOLDOWN_MS && lastRefresh.current > 0;

  if (error) {
    return <div className="betpal-alert betpal-alert--error">{error}</div>;
  }
  if (bets === null) return <p style={{ opacity: 0.6 }}>Loading bets…</p>;
  if (bets.length === 0) return <p style={{ opacity: 0.6, fontStyle: "italic" }}>No bets yet.</p>;

  return (
    <>
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
      <button
        onClick={handleRefresh}
        disabled={refreshing || cooldownActive}
        style={{ fontSize: 11, padding: "2px 8px" }}
      >
        {refreshing ? "Refreshing…" : cooldownActive ? "Wait 1 min" : "Refresh odds"}
      </button>
    </div>
    <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
      {bets.map((b) => (
        <li key={b.id} className="betpal-list-item">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Link href={`/bets/${b.id}`} style={{ fontWeight: 500 }}>
              {b.title}
            </Link>
            <span style={{ fontSize: 12, opacity: 0.7, whiteSpace: "nowrap", marginLeft: 8 }}>
              ${(b.stake_amount_cents / 100).toFixed(0)}/person
            </span>
          </div>
          <div style={{ marginTop: 4, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className={`betpal-status ${STATUS_CLASS[b.status] ?? "betpal-status--info"}`}>
              {b.status}
            </span>
            <span style={{ fontSize: 11, opacity: 0.75 }}>
              {b.stakes_count} {b.stakes_count === 1 ? "bet" : "bets"}
            </span>
            {b.my_outcome && (() => {
              const isSettled = b.status === "settled" && b.resolution_outcome != null;
              const won = isSettled && b.my_outcome === b.resolution_outcome;
              const lost = isSettled && !won;
              const payout = won && b.winners_count > 0 ? Math.floor(b.total_cents / b.winners_count) : 0;
              return (
                <span style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "1px 6px",
                  background: won ? "#28a745" : lost ? "#dc3545" : "#000080",
                  color: "#fff",
                  fontSize: 11,
                  fontWeight: 700,
                }}>
                  You: {b.my_outcome}
                  {won && <> · won ${(payout / 100).toFixed(2)}</>}
                  {lost && <> · lost ${(b.my_stake_cents / 100).toFixed(2)}</>}
                </span>
              );
            })()}
            {b.resolution_outcome && (
              <span style={{ fontWeight: 600 }}>Won by {b.resolution_outcome}</span>
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
    </>
  );
}
