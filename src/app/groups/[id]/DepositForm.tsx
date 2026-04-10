"use client";

/**
 * DepositForm — collects from-chain/from-token/amount, runs the three-phase
 * deposit flow via useDepositFlow, and shows the Win98 file-copy progress
 * dialog throughout.
 */
import { useState } from "react";
import { useWallets } from "@privy-io/react-auth";
import { CopyProgressDialog } from "@/components/win98/CopyProgressDialog";
import { useDepositFlow, SOURCES } from "@/hooks/useDepositFlow";

export function DepositForm({ groupId }: { groupId: string }) {
  const { wallets } = useWallets();
  const [sourceIdx, setSourceIdx] = useState(0);
  const [amount, setAmount] = useState("10");
  const [localError, setLocalError] = useState<string | null>(null);
  const flow = useDepositFlow();

  async function onDeposit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);

    const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
    if (!wallet) {
      setLocalError("no wallet available — sign in first");
      return;
    }

    await flow.execute({
      groupId,
      source: SOURCES[sourceIdx],
      amount,
      wallet,
    });
  }

  const displayError = localError ?? flow.error;

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
        {displayError && (
          <p className="text-xs" role="alert" style={{ color: "#a00" }}>
            {displayError}
          </p>
        )}
        <div>
          <button type="submit">Deposit</button>
        </div>
      </form>
      <CopyProgressDialog
        open={flow.open}
        title="Copying funds…"
        status={flow.status}
        progress={flow.progress}
        fromLabel={SOURCES[sourceIdx].label}
        toLabel="Group vault · Base"
        onClose={flow.reset}
      />
    </>
  );
}
