"use client";

/**
 * DepositForm — collects from-chain/from-token/amount, runs the three-phase
 * deposit flow via useDepositFlow, and shows the Win98 file-copy progress
 * dialog throughout.
 */
import { useState } from "react";
import { useWallets } from "@privy-io/react-auth";
import { CopyProgressDialog } from "@/components/win98/CopyProgressDialog";
import { useDepositFlow } from "@/hooks/useDepositFlow";
import { useDepositSources } from "@/hooks/useDepositSources";

export function DepositForm({ groupId }: { groupId: string }) {
  const { wallets } = useWallets();
  const { sources, loading: sourcesLoading } = useDepositSources();
  const [sourceIdx, setSourceIdx] = useState(0);
  const [amount, setAmount] = useState("10");
  const [localError, setLocalError] = useState<string | null>(null);
  const flow = useDepositFlow();

  const [fundingStep, setFundingStep] = useState<"idle" | "pending" | "done">("idle");

  function openFunding() {
    const w = 480, h = 700;
    const left = window.screenX + (window.innerWidth - w) / 2;
    const top = window.screenY + (window.innerHeight - h) / 2;
    window.open(
      "https://home.privy.io/",
      "betpal_fund",
      `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no,scrollbars=yes`,
    );
    setFundingStep("pending");
  }

  async function onDeposit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);

    const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
    if (!wallet) {
      setLocalError("no wallet available — sign in first");
      return;
    }

    const src = sources[sourceIdx];
    await flow.execute({
      groupId,
      source: {
        label: `${src.symbol} · ${src.chainName}`,
        chainId: src.chainId,
        token: src.token as `0x${string}`,
        decimals: src.decimals,
      },
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
            disabled={sourcesLoading}
            onChange={(e) => setSourceIdx(Number(e.target.value))}
          >
            {sources.map((s, i) => (
              <option key={`${s.chainId}-${s.token}`} value={i}>
                {s.symbol} · {s.chainName}
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
          <button type="button" onClick={openFunding}>
            {fundingStep === "pending" ? "Open wallet again" : "Add funds"}
          </button>
          {fundingStep === "pending" && (
            <button type="button" onClick={() => setFundingStep("done")}>
              Done
            </button>
          )}
        </div>

        {fundingStep === "pending" && (
          <div className="window" style={{ marginTop: 8 }}>
            <div className="window-body" style={{ padding: 8 }}>
              <p className="text-xs" style={{ margin: 0 }}>
                A wallet window has opened. Add funds there, then click <strong>Done</strong> when finished.
              </p>
            </div>
          </div>
        )}
        {fundingStep === "done" && (
          <p className="text-xs" style={{ color: "#080" }}>
            Funds added. You can now deposit to the group above.
          </p>
        )}
      </form>

      <CopyProgressDialog
        open={flow.open}
        title="Copying funds…"
        status={flow.status}
        progress={flow.progress}
        fromLabel={sources[sourceIdx] ? `${sources[sourceIdx].symbol} · ${sources[sourceIdx].chainName}` : "Source"}
        toLabel="Group vault · Base"
        onClose={flow.reset}
      />
    </>
  );
}
