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
import { useWalletBalances } from "@/hooks/useWalletBalances";
import { useDepositSources } from "@/hooks/useDepositSources";

/** Trim to max N decimal places, strip trailing zeros */
function trimDecimals(val: string, max: number): string {
  const num = Number(val);
  if (isNaN(num)) return val;
  return num.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: max,
  });
}

export function DepositForm({ groupId }: { groupId: string }) {
  const { wallets } = useWallets();
  const { balances, loading: balLoading, refresh: refreshBalance } = useWalletBalances();
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
            <button type="button" onClick={() => { setFundingStep("done"); refreshBalance(); }}>
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

      {/* ── Wallet balances ── */}
      <div className="window" style={{ marginTop: 8 }}>
        <div className="title-bar" style={{ padding: "2px 4px" }}>
          <div className="title-bar-text" style={{ fontSize: 11 }}>
            Available funds
          </div>
          <div className="title-bar-controls">
            <button
              aria-label="Refresh"
              disabled={balLoading}
              onClick={() => refreshBalance()}
              style={{ fontSize: 10, padding: "0 4px" }}
            >
              {balLoading ? "..." : "↻"}
            </button>
          </div>
        </div>
        <div className="window-body" style={{ padding: 6 }}>
          {balLoading && balances.length === 0 && (
            <p className="text-xs" style={{ margin: 0, color: "#666" }}>
              Loading balances...
            </p>
          )}
          {!balLoading && balances.length === 0 && (
            <p className="text-xs" style={{ margin: 0, color: "#666" }}>
              No funds yet.{" "}
              <button
                type="button"
                onClick={openFunding}
                style={{
                  background: "none",
                  border: "none",
                  color: "#00a",
                  textDecoration: "underline",
                  cursor: "pointer",
                  padding: 0,
                  fontSize: "inherit",
                }}
              >
                Add funds
              </button>
            </p>
          )}
          {balances.length > 0 && (
            <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
              <tbody>
                {balances.map((t) => {
                  const isStable = ["USDC", "USDbC", "DAI", "USDT"].includes(t.symbol);
                  const formatted = trimDecimals(
                    t.balanceFormatted,
                    isStable ? 2 : 6,
                  );
                  const usdVal =
                    t.priceUSD
                      ? (Number(t.priceUSD) * Number(t.balanceFormatted)).toFixed(2)
                      : null;
                  return (
                    <tr key={t.address} style={{ borderBottom: "1px solid #dfdfdf" }}>
                      <td style={{ padding: "2px 0", fontWeight: 600 }}>
                        {t.symbol}
                      </td>
                      <td style={{ padding: "2px 4px", textAlign: "right" }}>
                        {formatted}
                      </td>
                      {usdVal && (
                        <td style={{ padding: "2px 0", textAlign: "right", color: "#666" }}>
                          ${usdVal}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          className="text-xs"
          onClick={() => window.open("https://home.privy.io/", "betpal_fund")}
          style={{ fontSize: 11 }}
        >
          Manage wallet
        </button>
      </div>

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
