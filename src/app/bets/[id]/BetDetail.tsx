"use client";

/**
 * BetDetail — view a bet, its stakes, and place / inspect your own stake.
 *
 * Sections:
 *   - Header: title, status, deadline, Polymarket link
 *   - Per-outcome stake summary (count, total cents)
 *   - Stake form (only if status=open, not yet staked, deadline not passed)
 *   - "Resolve now" button (only when status=open, deadline passed) → calls
 *     the resolution endpoint which polls Polymarket and either keeps it in
 *     `locked`/`resolving` state or settles it.
 */
import { useCallback, useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { authedFetch } from "@/lib/clientFetch";

type Bet = {
  id: string;
  group_id: string;
  creator_id: string;
  title: string;
  options: string[];
  polymarket_market_id: string;
  polymarket_url: string;
  join_deadline: string;
  max_resolution_date: string;
  status: string;
  resolution_outcome: string | null;
  settled_at: string | null;
  created_at: string;
};

type Stake = {
  id: string;
  user_id: string;
  outcome_chosen: string;
  amount_cents: number;
  created_at: string;
};

type DetailResponse = {
  bet: Bet;
  stakes: Stake[];
  my_stake: Stake | null;
};

function fmtCents(c: number) {
  return (c / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

export function BetDetail({ betId }: { betId: string }) {
  const { ready, authenticated, login } = usePrivy();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState("");
  const [amountUsd, setAmountUsd] = useState("5");
  const [submitting, setSubmitting] = useState(false);
  const [resolving, setResolving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const d = await authedFetch<DetailResponse>(`/api/bets/${betId}`);
      setData(d);
      if (!outcome && d.bet.options.length > 0) {
        setOutcome(d.bet.options[0]);
      }
    } catch (e) {
      setError((e as Error).message);
    }
    // outcome intentionally excluded from deps — we only want to seed it once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [betId]);

  useEffect(() => {
    if (!ready || !authenticated) return;
    void reload();
  }, [ready, authenticated, reload]);

  if (!ready) return <p>Loading…</p>;
  if (!authenticated) {
    return (
      <div className="flex flex-col gap-3">
        <p>Sign in to view this bet.</p>
        <div>
          <button onClick={() => login()}>Sign in</button>
        </div>
      </div>
    );
  }
  if (error) return <p style={{ color: "#a00" }}>{error}</p>;
  if (!data) return <p>Loading bet…</p>;

  const { bet, stakes, my_stake } = data;
  const joinPassed = new Date(bet.join_deadline).getTime() <= Date.now();

  // Per-outcome aggregates.
  const buckets = new Map<string, { count: number; cents: number }>();
  for (const o of bet.options) buckets.set(o, { count: 0, cents: 0 });
  for (const s of stakes) {
    const b = buckets.get(s.outcome_chosen);
    if (b) {
      b.count += 1;
      b.cents += Number(s.amount_cents);
    }
  }
  const totalCents = stakes.reduce((a, s) => a + Number(s.amount_cents), 0);

  async function placeStake(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const cents = Math.round(parseFloat(amountUsd) * 100);
      if (!Number.isFinite(cents) || cents <= 0) {
        throw new Error("amount must be > 0");
      }
      await authedFetch(`/api/bets/${betId}/stake`, {
        method: "POST",
        body: JSON.stringify({ outcome, amount_cents: cents }),
      });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function tryResolve() {
    setResolving(true);
    setError(null);
    try {
      await authedFetch(`/api/bets/${betId}/resolve`, { method: "POST" });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setResolving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <h3 style={{ margin: 0 }}>{bet.title}</h3>
      <div className="text-xs">
        <strong>Status:</strong> {bet.status}
        {bet.resolution_outcome ? ` · won by ${bet.resolution_outcome}` : ""}
      </div>
      <div className="text-xs">
        <strong>Join deadline:</strong>{" "}
        {new Date(bet.join_deadline).toLocaleString()}
      </div>
      <div className="text-xs">
        <a href={bet.polymarket_url} target="_blank" rel="noreferrer">
          View on Polymarket ↗
        </a>
      </div>

      <hr style={{ margin: "8px 0" }} />
      <strong>Pool</strong>
      <ul className="text-xs" style={{ margin: 0, paddingLeft: 16 }}>
        {bet.options.map((o) => {
          const b = buckets.get(o)!;
          return (
            <li key={o}>
              {o}: {b.count} stakers · {fmtCents(b.cents)}
            </li>
          );
        })}
        <li>Total pool: {fmtCents(totalCents)}</li>
      </ul>

      {my_stake && (
        <>
          <hr style={{ margin: "8px 0" }} />
          <div className="text-xs">
            <strong>Your stake:</strong> {fmtCents(my_stake.amount_cents)} on{" "}
            {my_stake.outcome_chosen}
          </div>
        </>
      )}

      {!my_stake && bet.status === "open" && !joinPassed && (
        <>
          <hr style={{ margin: "8px 0" }} />
          <strong>Place stake</strong>
          <form onSubmit={placeStake} className="flex flex-col gap-2">
            <div className="field-row-stacked">
              <label htmlFor="stake-outcome">Outcome</label>
              <select
                id="stake-outcome"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
              >
                {bet.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-row-stacked">
              <label htmlFor="stake-amount">Amount (USD)</label>
              <input
                id="stake-amount"
                type="text"
                inputMode="decimal"
                value={amountUsd}
                onChange={(e) => setAmountUsd(e.target.value)}
              />
            </div>
            <div>
              <button type="submit" disabled={submitting}>
                {submitting ? "Locking…" : "Lock stake"}
              </button>
            </div>
          </form>
        </>
      )}

      {bet.status === "open" && joinPassed && (
        <>
          <hr style={{ margin: "8px 0" }} />
          <div className="flex items-center gap-2">
            <button onClick={tryResolve} disabled={resolving}>
              {resolving ? "Checking Polymarket…" : "Try to resolve"}
            </button>
            <span className="text-xs">
              Join deadline passed. Polymarket must be settled before payouts run.
            </span>
          </div>
        </>
      )}

      {error && (
        <p className="text-xs" style={{ color: "#a00" }}>
          {error}
        </p>
      )}
    </div>
  );
}
