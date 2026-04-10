"use client";

/**
 * DepositForm — collects from-chain/from-token/amount, runs the three-phase
 * deposit flow against the API, and shows the Win98 file-copy progress dialog
 * throughout.
 *
 * Phases:
 *   1. POST /api/groups/:id/deposits     → quote + depositId
 *   2. wallet.sendTransaction(quote.transactionRequest) → tx hash
 *      then PATCH /api/groups/:id/deposits/:depositId   → executing
 *   3. POST /api/groups/:id/deposits/:depositId/confirm (poll until DONE)
 *
 * The chain/token list is intentionally tiny for the demo: USDC on Base or
 * USDC on Polygon. Day 3 broadens this via LI.FI's /tokens endpoint.
 */
import { useState } from "react";
import { useWallets } from "@privy-io/react-auth";
import { CopyProgressDialog } from "@/components/win98/CopyProgressDialog";
import { authedFetch } from "@/lib/clientFetch";
import { toBaseUnits } from "@/lib/amounts";

type SourceChoice = {
  label: string;
  chainId: number;
  // ERC-20 contract address in the source chain.
  token: `0x${string}`;
  // 6 for USDC.
  decimals: number;
};

const SOURCES: SourceChoice[] = [
  {
    label: "USDC · Base",
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

type QuoteResponse = {
  depositId: string;
  quote: {
    id: string;
    transactionRequest: {
      to: string;
      data: string;
      value?: string;
      chainId?: number;
      gasLimit?: string;
      gasPrice?: string;
    };
    estimate: { toAmount: string; toAmountMin: string; executionDuration?: number };
  };
};

export function DepositForm({ groupId }: { groupId: string }) {
  const { wallets } = useWallets();
  const [sourceIdx, setSourceIdx] = useState(0);
  const [amount, setAmount] = useState("10");
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  async function onDeposit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const source = SOURCES[sourceIdx];
    let fromAmount: string;
    try {
      fromAmount = toBaseUnits(amount, source.decimals);
      if (fromAmount === "0") throw new Error("amount must be > 0");
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    // amountCents tracks USD-equivalent for the ledger. USDC ≈ $1, so cents
    // = amount * 100. Day 3 plugs in a real price oracle.
    const amountCents = Math.round(parseFloat(amount) * 100);

    // Find an embedded wallet to sign with.
    const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
    if (!wallet) {
      setError("no wallet available — sign in first");
      return;
    }

    setOpen(true);
    setProgress(undefined);
    try {
      // Phase 1: get quote.
      setStatus("Quoting route via LI.FI Composer…");
      const quoteRes = await authedFetch<QuoteResponse>(
        `/api/groups/${groupId}/deposits`,
        {
          method: "POST",
          body: JSON.stringify({
            fromChain: source.chainId,
            fromToken: source.token,
            fromAmount,
            amountCents,
          }),
        },
      );

      // Phase 2: ensure wallet on the right chain, then send.
      setStatus("Switching wallet to source chain…");
      try {
        await wallet.switchChain(source.chainId);
      } catch (err) {
        // Some wallets don't need switching; ignore.
        console.warn("switchChain failed (continuing):", err);
      }

      setStatus("Awaiting signature…");
      const provider = await wallet.getEthereumProvider();
      const txParams = {
        from: wallet.address,
        to: quoteRes.quote.transactionRequest.to,
        data: quoteRes.quote.transactionRequest.data,
        value: quoteRes.quote.transactionRequest.value ?? "0x0",
      };
      const txHash = (await provider.request({
        method: "eth_sendTransaction",
        params: [txParams],
      })) as string;

      setStatus("Reporting tx hash to BetPal…");
      await authedFetch(
        `/api/groups/${groupId}/deposits/${quoteRes.depositId}`,
        { method: "PATCH", body: JSON.stringify({ txHash }) },
      );

      // Phase 3: poll confirm. We poll up to ~5 minutes; the bar fills as we
      // approach the timeout. Real settlement is usually <1 min on Base from
      // Polygon, but be generous.
      const start = Date.now();
      const timeoutMs = 5 * 60 * 1000;
      let done = false;
      while (!done) {
        const elapsed = Date.now() - start;
        const pct = Math.min(95, Math.round((elapsed / timeoutMs) * 95));
        setProgress(pct);
        setStatus("Bridging via LI.FI Composer…");
        const res = await authedFetch<{ status: string }>(
          `/api/groups/${groupId}/deposits/${quoteRes.depositId}/confirm`,
          { method: "POST" },
        );
        if (res.status === "completed") {
          setProgress(100);
          setStatus("Funds delivered to group vault.");
          done = true;
          break;
        }
        if (res.status === "failed" || res.status === "reverted") {
          throw new Error(`deposit ${res.status}`);
        }
        if (elapsed >= timeoutMs) {
          throw new Error("deposit timed out — check the dashboard later");
        }
        await new Promise((r) => setTimeout(r, 4000));
      }
    } catch (err) {
      setStatus("Failed.");
      setError((err as Error).message);
    }
  }

  function closeDialog() {
    setOpen(false);
    setStatus("");
    setProgress(undefined);
  }

  return (
    <>
      <form onSubmit={onDeposit} className="flex flex-col gap-2">
        <div className="field-row-stacked">
          <label htmlFor="dep-source">Source</label>
          <select
            id="dep-source"
            value={sourceIdx}
            onChange={(e) => setSourceIdx(Number(e.target.value))}
          >
            {SOURCES.map((s, i) => (
              <option key={s.label} value={i}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field-row-stacked">
          <label htmlFor="dep-amount">Amount (USDC)</label>
          <input
            id="dep-amount"
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
          <button type="submit">Deposit</button>
        </div>
      </form>
      <CopyProgressDialog
        open={open}
        title="Copying funds…"
        status={status}
        progress={progress}
        fromLabel={SOURCES[sourceIdx].label}
        toLabel="Group vault · Base"
        onClose={closeDialog}
      />
    </>
  );
}
