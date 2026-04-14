"use client";

/**
 * WithdrawForm — server-side withdrawal from the group's Morpho vault.
 * The server redeems vault shares and sends USDC to the user's wallet.
 */
import { useCallback, useEffect, useState } from "react";
import { authedFetch } from "@/lib/clientFetch";
import { fmtCentsPrecise } from "@/lib/format";

type PartialWithdrawal = {
  id: string;
  amount_cents: number;
  status: string;
  tx_hash: string | null;
  error_message: string | null;
  created_at: string;
};

export function WithdrawForm({
  groupId,
  freeBalanceCents,
  onWithdrawn,
}: {
  groupId: string;
  freeBalanceCents: number;
  onWithdrawn: () => void;
}) {
  const [amount, setAmount] = useState("5");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    transferTxHash: string;
    amountCents: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [partials, setPartials] = useState<PartialWithdrawal[]>([]);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const loadPartials = useCallback(async () => {
    try {
      const data = await authedFetch<{ withdrawals: PartialWithdrawal[] }>(
        `/api/groups/${groupId}/withdrawals?status=partial`,
      );
      setPartials(data.withdrawals);
    } catch { /* silent */ }
  }, [groupId]);

  useEffect(() => { void loadPartials(); }, [loadPartials]);

  async function retryPartial(id: string) {
    setRetryingId(id);
    setError(null);
    try {
      await authedFetch(`/api/groups/${groupId}/withdrawals/${id}/retry`, {
        method: "POST",
      });
      await loadPartials();
      onWithdrawn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRetryingId(null);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);

    const amountCents = Math.round(parseFloat(amount) * 100);
    if (!amountCents || amountCents <= 0) {
      setError("Amount must be > 0");
      return;
    }

    setSubmitting(true);
    try {
      const res = await authedFetch<{
        withdrawalId: string;
        transferTxHash: string;
        amountCents: number;
        status: string;
      }>(`/api/groups/${groupId}/withdrawals`, {
        method: "POST",
        body: JSON.stringify({ amountCents }),
      });
      setResult(res);
      void loadPartials();
      onWithdrawn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      {partials.length > 0 && (
        <div className="betpal-alert betpal-alert--warning" style={{ fontSize: 12 }}>
          <strong>Stuck withdrawal{partials.length > 1 ? "s" : ""}:</strong> the vault
          paid out but the transfer to your wallet failed. Retry to claim the USDC
          waiting in the group wallet.
          <ul style={{ margin: "6px 0 0 0", padding: 0, listStyle: "none" }}>
            {partials.map((p) => (
              <li key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                <span>{fmtCentsPrecise(p.amount_cents)}</span>
                <button
                  type="button"
                  onClick={() => retryPartial(p.id)}
                  disabled={retryingId === p.id}
                  style={{ fontSize: 11, padding: "2px 8px" }}
                >
                  {retryingId === p.id ? "Retrying…" : "Retry"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div style={{ fontSize: 13, marginBottom: 2 }}>
        Available: <strong>${(freeBalanceCents / 100).toFixed(2)}</strong>
      </div>
      <div className="field-row-stacked" style={{ gap: 4 }}>
        <label htmlFor="wd-amount">Amount (USD)</label>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input
            id="wd-amount"
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={{ flex: 1, height: 32, boxSizing: "border-box" }}
          />
          <button
            type="button"
            onClick={() => setAmount((freeBalanceCents / 100).toFixed(2))}
            style={{ height: 32, minHeight: 32, boxSizing: "border-box" }}
          >
            Max
          </button>
        </div>
      </div>
      {error && (
        <div className="betpal-alert betpal-alert--error" role="alert">
          {error}
        </div>
      )}
      <div>
        <button type="submit" disabled={submitting}>
          {submitting ? "Withdrawing…" : "Withdraw to wallet"}
        </button>
      </div>
      {result && (
        <div className="betpal-alert betpal-alert--success">
          Withdrawn ${(result.amountCents / 100).toFixed(2)} to your wallet.
          <br />
          Tx:{" "}
          <a
            href={`https://basescan.org/tx/${result.transferTxHash}`}
            target="_blank"
            rel="noreferrer"
          >
            {result.transferTxHash.slice(0, 18)}…
          </a>
        </div>
      )}
    </form>
  );
}
