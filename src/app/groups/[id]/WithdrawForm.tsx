"use client";

/**
 * WithdrawForm — server-side withdrawal from the group's Morpho vault.
 * The server redeems vault shares and sends USDC to the user's wallet.
 */
import { useState } from "react";
import { authedFetch } from "@/lib/clientFetch";

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
      onWithdrawn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
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
