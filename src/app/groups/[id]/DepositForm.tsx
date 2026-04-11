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

  const [fundingOpen, setFundingOpen] = useState(false);

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
        <div className="flex gap-2">
          <button type="submit">Deposit</button>
          <button type="button" onClick={() => setFundingOpen(true)}>Add funds</button>
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
      {fundingOpen && (
        <div
          className="fixed inset-0 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.35)", zIndex: 50 }}
          role="dialog"
          aria-modal="true"
          aria-label="Add funds"
        >
          <div className="window" style={{ width: 480, height: 600 }}>
            <div className="title-bar">
              <div className="title-bar-text">Add funds</div>
              <div className="title-bar-controls">
                <button aria-label="Close" onClick={() => setFundingOpen(false)} />
              </div>
            </div>
            <div className="window-body" style={{ padding: 0, height: "calc(100% - 28px)" }}>
              <iframe
                src="https://home.privy.io/"
                style={{ width: "100%", height: "100%", border: "none" }}
                allow="payment; clipboard-write"
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
