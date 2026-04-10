"use client";

/**
 * WithdrawForm — request a Composer route to unwind a user's free balance
 * from the group's Morpho vault to a destination chain/token of their
 * choice.
 *
 * For the demo this stops at "quote ready"; actually moving funds out of
 * the Safe needs threshold-many co-signs and is wired through the Safe
 * Web App. We surface a deeplink + the route summary so the user can
 * complete the on-chain side.
 *
 * Idempotent retries are safe — the API keys the transactions row on
 * (composer_route_id, user_id) and the ledger reservation on the
 * withdrawal id.
 */
import { useState } from "react";
import { authedFetch } from "@/lib/clientFetch";
import { toBaseUnits } from "@/lib/amounts";

type DestChoice = {
  label: string;
  chainId: number;
  token: `0x${string}`;
  decimals: number;
};

const DESTS: DestChoice[] = [
  {
    label: "USDC · Base (skip bridge)",
    chainId: 8453,
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
  },
  {
    label: "USDC · Polygon",
    chainId: 137,
    token: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    decimals: 6,
  },
];

type WithdrawalResponse = {
  withdrawalId: string;
  quote: {
    id: string;
    estimate: { toAmount: string; toAmountMin: string };
  };
};

export function WithdrawForm({
  groupId,
  safeAddress,
  onWithdrawn,
}: {
  groupId: string;
  safeAddress: string | null;
  onWithdrawn: () => void;
}) {
  const [destIdx, setDestIdx] = useState(0);
  const [amount, setAmount] = useState("5");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<WithdrawalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHashInput, setTxHashInput] = useState("");
  const [confirmStatus, setConfirmStatus] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function onConfirmTxHash(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!result) return;
    const trimmed = txHashInput.trim();
    if (!/^0x[0-9a-fA-F]+$/.test(trimmed)) {
      setError("tx hash must be 0x-hex");
      return;
    }
    setConfirming(true);
    setConfirmStatus("Reporting tx hash to BetPal…");
    try {
      await authedFetch(
        `/api/groups/${groupId}/withdrawals/${result.withdrawalId}`,
        { method: "PATCH", body: JSON.stringify({ txHash: trimmed }) },
      );

      // Poll confirm up to 5 minutes — Safe execution + Composer bridge can be
      // slow, especially across chains.
      const start = Date.now();
      const timeoutMs = 5 * 60 * 1000;
      while (true) {
        const r = await authedFetch<{ status: string }>(
          `/api/groups/${groupId}/withdrawals/${result.withdrawalId}/confirm`,
          { method: "POST" },
        );
        if (r.status === "completed") {
          setConfirmStatus("Withdrawal completed.");
          onWithdrawn();
          break;
        }
        if (r.status === "failed" || r.status === "reverted") {
          // The confirm endpoint already reversed the reservation; refresh.
          onWithdrawn();
          throw new Error(`withdrawal ${r.status}`);
        }
        if (Date.now() - start >= timeoutMs) {
          throw new Error("withdrawal timed out — check the dashboard later");
        }
        setConfirmStatus("Bridging via LI.FI Composer…");
        await new Promise((res) => setTimeout(res, 4000));
      }
    } catch (err) {
      setError((err as Error).message);
      setConfirmStatus(null);
    } finally {
      setConfirming(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    const dest = DESTS[destIdx];
    let fromAmount: string;
    try {
      // The vault token uses the same decimals as USDC for Morpho USDC vaults.
      fromAmount = toBaseUnits(amount, dest.decimals);
      if (fromAmount === "0") throw new Error("amount must be > 0");
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    const amountCents = Math.round(parseFloat(amount) * 100);
    setSubmitting(true);
    try {
      const res = await authedFetch<WithdrawalResponse>(
        `/api/groups/${groupId}/withdrawals`,
        {
          method: "POST",
          body: JSON.stringify({
            toChain: dest.chainId,
            toToken: dest.token,
            amountCents,
            fromAmount,
          }),
        },
      );
      setResult(res);
      onWithdrawn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const safeAppLink = safeAddress
    ? `https://app.safe.global/home?safe=base:${safeAddress}`
    : null;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <div className="field-row-stacked">
        <label htmlFor="wd-dest">Destination</label>
        <select
          id="wd-dest"
          value={destIdx}
          onChange={(e) => setDestIdx(Number(e.target.value))}
        >
          {DESTS.map((d, i) => (
            <option key={d.label} value={i}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field-row-stacked">
        <label htmlFor="wd-amount">Amount (USD)</label>
        <input
          id="wd-amount"
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      {error && (
        <p className="text-xs" role="alert" style={{ color: "#a00" }}>
          {error}
        </p>
      )}
      <div>
        <button type="submit" disabled={submitting}>
          {submitting ? "Quoting…" : "Get withdrawal route"}
        </button>
      </div>
      {result && (
        <div className="text-xs flex flex-col gap-2">
          <span>
            <strong>Route ready.</strong> Quote id: {result.quote.id.slice(0, 12)}…
          </span>
          <span>
            You&apos;ll receive ≈ {result.quote.estimate.toAmount} (min{" "}
            {result.quote.estimate.toAmountMin}) base units of the destination
            token.
          </span>
          {safeAppLink && (
            <span>
              Submit the Safe transaction to execute:{" "}
              <a href={safeAppLink} target="_blank" rel="noreferrer">
                Open Safe Web App ↗
              </a>
            </span>
          )}
          <div className="field-row-stacked">
            <label htmlFor="wd-txhash">Safe execution tx hash (after co-sign)</label>
            <input
              id="wd-txhash"
              type="text"
              placeholder="0x…"
              value={txHashInput}
              onChange={(ev) => setTxHashInput(ev.target.value)}
              disabled={confirming}
            />
          </div>
          <div>
            <button
              type="button"
              onClick={onConfirmTxHash}
              disabled={confirming || !txHashInput.trim()}
            >
              {confirming ? "Confirming…" : "Confirm withdrawal"}
            </button>
          </div>
          {confirmStatus && <span>{confirmStatus}</span>}
        </div>
      )}
    </form>
  );
}
