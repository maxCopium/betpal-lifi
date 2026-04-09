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
    return (
      <p className="text-xs" style={{ color: "#a00" }}>
        {error}
      </p>
    );
  }
  if (bets === null) return <p className="text-xs">Loading bets…</p>;
  if (bets.length === 0) return <p className="text-xs">No bets yet.</p>;

  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
      {bets.map((b) => (
        <li
          key={b.id}
          style={{
            padding: "4px 0",
            borderBottom: "1px dotted #888",
          }}
        >
          <Link
            href={`/bets/${b.id}`}
            style={{ fontSize: 12, color: "#000080" }}
          >
            {b.title}
          </Link>
          <div className="text-xs" style={{ opacity: 0.7 }}>
            {b.status}
            {b.resolution_outcome ? ` · ${b.resolution_outcome}` : ""} · join by{" "}
            {new Date(b.join_deadline).toLocaleString()}
          </div>
        </li>
      ))}
    </ul>
  );
}
