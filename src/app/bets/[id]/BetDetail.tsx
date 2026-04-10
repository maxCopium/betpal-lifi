"use client";

/**
 * BetDetail — view a bet, its stakes, and join via deposit-and-bet or
 * stake from existing balance.
 *
 * Sections:
 *   - Header: title, status, deadline, Polymarket link
 *   - Per-outcome stake summary (count, total cents)
 *   - "Join this bet" form:
 *       Primary: deposit & bet in one action (uses useDepositFlow)
 *       Secondary: stake from existing group balance
 *   - "Resolve now" button (only when status=open, deadline passed)
 */
import { useCallback, useEffect, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { authedFetch } from "@/lib/clientFetch";
import { CopyProgressDialog } from "@/components/win98/CopyProgressDialog";
import { useDepositFlow, SOURCES } from "@/hooks/useDepositFlow";

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
  user_label?: string;
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
  const { wallets } = useWallets();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState("");
  const [amountUsd, setAmountUsd] = useState("5");
  const [sourceIdx, setSourceIdx] = useState(0);
  const [mode, setMode] = useState<"deposit" | "balance">("deposit");
  const [submitting, setSubmitting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const flow = useDepositFlow();

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [betId]);

  useEffect(() => {
    if (!ready || !authenticated) return;
    void reload();
  }, [ready, authenticated, reload]);

  // Reload bet data after deposit flow completes.
  useEffect(() => {
    if (flow.stakeStatus) void reload();
  }, [flow.stakeStatus, reload]);

  if (!ready) return <p>Loading...</p>;
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
  if (error && !data) return <p style={{ color: "#a00" }}>{error}</p>;
  if (!data) return <p>Loading bet...</p>;

  const { bet, stakes, my_stake } = data;
  const joinPassed = new Date(bet.join_deadline).getTime() <= Date.now();

  const buckets = new Map<
    string,
    { count: number; cents: number; stakers: { label: string; cents: number }[] }
  >();
  for (const o of bet.options) buckets.set(o, { count: 0, cents: 0, stakers: [] });
  for (const s of stakes) {
    const b = buckets.get(s.outcome_chosen);
    if (b) {
      b.count += 1;
      b.cents += Number(s.amount_cents);
      b.stakers.push({
        label: s.user_label ?? "user",
        cents: Number(s.amount_cents),
      });
    }
  }
  const totalCents = stakes.reduce((a, s) => a + Number(s.amount_cents), 0);

  async function depositAndBet(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
    if (!wallet) {
      setError("no wallet available — sign in first");
      return;
    }
    await flow.execute({
      groupId: bet.group_id,
      source: SOURCES[sourceIdx],
      amount: amountUsd,
      wallet,
      betId: bet.id,
      outcome,
    });
  }

  async function stakeFromBalance(e: React.FormEvent) {
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

  const canJoin = !my_stake && bet.status === "open" && !joinPassed;

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
              <div>
                {o}: {b.count} stakers · {fmtCents(b.cents)}
              </div>
              {b.stakers.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  {b.stakers.map((s, i) => (
                    <li key={i}>
                      {s.label} · {fmtCents(s.cents)}
                    </li>
                  ))}
                </ul>
              )}
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

      {canJoin && (
        <>
          <hr style={{ margin: "8px 0" }} />
          <strong>Join this bet</strong>
          <div className="flex gap-2 text-xs" style={{ marginBottom: 4 }}>
            <label>
              <input
                type="radio"
                name="join-mode"
                checked={mode === "deposit"}
                onChange={() => setMode("deposit")}
              />{" "}
              Deposit & bet
            </label>
            <label>
              <input
                type="radio"
                name="join-mode"
                checked={mode === "balance"}
                onChange={() => setMode("balance")}
              />{" "}
              Bet from balance
            </label>
          </div>

          {mode === "deposit" ? (
            <form onSubmit={depositAndBet} className="flex flex-col gap-2">
              <div className="field-row-stacked">
                <label htmlFor="join-outcome">Outcome</label>
                <select
                  id="join-outcome"
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                >
                  {bet.options.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </div>
              <div className="field-row-stacked">
                <label htmlFor="join-amount">Amount (USDC)</label>
                <input
                  id="join-amount"
                  type="text"
                  inputMode="decimal"
                  value={amountUsd}
                  onChange={(e) => setAmountUsd(e.target.value)}
                />
              </div>
              <div className="field-row-stacked">
                <label htmlFor="join-source">Source</label>
                <select
                  id="join-source"
                  value={sourceIdx}
                  onChange={(e) => setSourceIdx(Number(e.target.value))}
                >
                  {SOURCES.map((s, i) => (
                    <option key={s.label} value={i}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <button type="submit">
                  Bet ${amountUsd} on {outcome || "..."}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={stakeFromBalance} className="flex flex-col gap-2">
              <div className="field-row-stacked">
                <label htmlFor="bal-outcome">Outcome</label>
                <select
                  id="bal-outcome"
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                >
                  {bet.options.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </div>
              <div className="field-row-stacked">
                <label htmlFor="bal-amount">Amount (USD)</label>
                <input
                  id="bal-amount"
                  type="text"
                  inputMode="decimal"
                  value={amountUsd}
                  onChange={(e) => setAmountUsd(e.target.value)}
                />
              </div>
              <div>
                <button type="submit" disabled={submitting}>
                  {submitting ? "Locking..." : "Stake from balance"}
                </button>
              </div>
            </form>
          )}
        </>
      )}

      {bet.status === "open" && joinPassed && (
        <>
          <hr style={{ margin: "8px 0" }} />
          <div className="flex items-center gap-2">
            <button onClick={tryResolve} disabled={resolving}>
              {resolving ? "Checking Polymarket..." : "Try to resolve"}
            </button>
            <span className="text-xs">
              Join deadline passed. Polymarket must be settled before payouts run.
            </span>
          </div>
        </>
      )}

      {(error || flow.error) && (
        <p className="text-xs" style={{ color: "#a00" }}>
          {error || flow.error}
        </p>
      )}

      <CopyProgressDialog
        open={flow.open}
        title="Depositing & betting..."
        status={flow.status}
        progress={flow.progress}
        fromLabel={SOURCES[sourceIdx].label}
        toLabel={`Bet: ${outcome || "..."}`}
        onClose={flow.reset}
      />
    </div>
  );
}
