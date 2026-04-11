"use client";

/**
 * BetDetail — view a bet, its stakes, and join via deposit-and-bet or
 * stake from existing balance.
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

function formatDate(iso: string): string {
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
  const [cancelVotes, setCancelVotes] = useState<{ votes: number; total: number } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const flow = useDepositFlow();

  const reload = useCallback(async () => {
    try {
      const d = await authedFetch<DetailResponse>(`/api/bets/${betId}`);
      setData(d);
      if (!outcome && d.bet.options.length > 0) {
        setOutcome(d.bet.options[0]);
      }
      try {
        const cv = await authedFetch<{ votes: number; total: number }>(
          `/api/bets/${betId}/cancel-vote`,
        );
        setCancelVotes(cv);
      } catch { /* ignore */ }
    } catch (e) {
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [betId]);

  useEffect(() => {
    if (!ready || !authenticated) return;
    void reload();
  }, [ready, authenticated, reload]);

  useEffect(() => {
    if (flow.stakeStatus) void reload();
  }, [flow.stakeStatus, reload]);

  if (!ready) return <p>Loading...</p>;
  if (!authenticated) {
    return (
      <div className="flex flex-col gap-4" style={{ padding: 16 }}>
        <p>Sign in to view this bet.</p>
        <div><button onClick={() => login()}>Sign in</button></div>
      </div>
    );
  }
  if (error && !data) return <div className="betpal-alert betpal-alert--error">{error}</div>;
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
      setError("No wallet available — sign in first");
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
        throw new Error("Amount must be > 0");
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

  async function voteCancelBet() {
    setCancelling(true);
    setError(null);
    try {
      const res = await authedFetch<{ unanimous: boolean; votes: number; total: number }>(
        `/api/bets/${betId}/cancel-vote`,
        { method: "POST" },
      );
      setCancelVotes({ votes: res.votes, total: res.total });
      if (res.unanimous) await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCancelling(false);
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
    <div className="flex flex-col gap-3">
      {/* Header */}
      <h3 style={{ margin: 0, fontSize: 16 }}>{bet.title}</h3>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <span className={`betpal-status ${STATUS_CLASS[bet.status] ?? "betpal-status--info"}`}>
          {bet.status}
        </span>
        {bet.resolution_outcome && (
          <strong style={{ color: "var(--betpal-color-success)" }}>
            Won by {bet.resolution_outcome}
          </strong>
        )}
        <span style={{ opacity: 0.7 }}>
          Join by {formatDate(bet.join_deadline)}
        </span>
        <a href={bet.polymarket_url} target="_blank" rel="noreferrer">
          Polymarket ↗
        </a>
      </div>

      {/* Pool breakdown */}
      <hr style={{ margin: "4px 0", borderTop: "1px solid #ccc" }} />
      <strong style={{ fontSize: 14 }}>Pool — {fmtCents(totalCents)}</strong>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {bet.options.map((o) => {
          const b = buckets.get(o)!;
          const pct = totalCents > 0 ? Math.round((b.cents / totalCents) * 100) : 0;
          return (
            <div key={o} style={{ padding: "8px 10px", background: "#f5f5f5", border: "1px solid #ddd" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <strong>{o}</strong>
                <span>{fmtCents(b.cents)} ({pct}%)</span>
              </div>
              {/* Visual bar */}
              <div style={{ height: 6, background: "#ddd", marginBottom: 4 }}>
                <div style={{ height: "100%", width: `${pct}%`, background: "#000080", transition: "width 0.3s" }} />
              </div>
              {b.stakers.length > 0 && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", opacity: 0.7 }}>
                  {b.stakers.map((s, i) => (
                    <span key={i}>{s.label} · {fmtCents(s.cents)}</span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Your stake */}
      {my_stake && (
        <>
          <hr style={{ margin: "4px 0", borderTop: "1px solid #ccc" }} />
          <div className="betpal-alert betpal-alert--info">
            <strong>Your stake:</strong> {fmtCents(my_stake.amount_cents)} on {my_stake.outcome_chosen}
          </div>
        </>
      )}

      {/* Cancel vote */}
      {my_stake && bet.status !== "settled" && bet.status !== "voided" && (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={voteCancelBet} disabled={cancelling}>
            {cancelling ? "Voting..." : "Vote to cancel bet"}
          </button>
          {cancelVotes && (
            <span>
              <strong>{cancelVotes.votes}/{cancelVotes.total}</strong> agreed to cancel
            </span>
          )}
        </div>
      )}

      {/* Join form */}
      {canJoin && (
        <>
          <hr style={{ margin: "4px 0", borderTop: "1px solid #ccc" }} />
          <strong style={{ fontSize: 14 }}>Join this bet</strong>
          <div style={{ display: "flex", gap: 16, marginBottom: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <input
                type="radio"
                name="join-mode"
                checked={mode === "deposit"}
                onChange={() => setMode("deposit")}
              />
              Deposit & bet
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <input
                type="radio"
                name="join-mode"
                checked={mode === "balance"}
                onChange={() => setMode("balance")}
              />
              Bet from balance
            </label>
          </div>

          {mode === "deposit" ? (
            <form onSubmit={depositAndBet} className="flex flex-col gap-3">
              <div className="field-row-stacked" style={{ gap: 4 }}>
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
              <div className="field-row-stacked" style={{ gap: 4 }}>
                <label htmlFor="join-amount">Amount (USDC)</label>
                <input
                  id="join-amount"
                  type="text"
                  inputMode="decimal"
                  value={amountUsd}
                  onChange={(e) => setAmountUsd(e.target.value)}
                />
              </div>
              <div className="field-row-stacked" style={{ gap: 4 }}>
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
            <form onSubmit={stakeFromBalance} className="flex flex-col gap-3">
              <div className="field-row-stacked" style={{ gap: 4 }}>
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
              <div className="field-row-stacked" style={{ gap: 4 }}>
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

      {/* Resolve button */}
      {bet.status === "open" && joinPassed && (
        <>
          <hr style={{ margin: "4px 0", borderTop: "1px solid #ccc" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={tryResolve} disabled={resolving}>
              {resolving ? "Checking Polymarket..." : "Try to resolve"}
            </button>
            <span style={{ opacity: 0.7 }}>
              Join deadline passed. Polymarket must settle first.
            </span>
          </div>
        </>
      )}

      {/* Errors */}
      {(error || flow.error) && (
        <div className="betpal-alert betpal-alert--error">
          {error || flow.error}
        </div>
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
