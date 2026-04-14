"use client";

/**
 * SendDialog — peer-to-peer wallet transfer modal.
 *
 * Pick a holding (any chain, any token LI.FI knows about) and an amount;
 * recipient is fixed to the member you clicked. Same-chain USDC on Base
 * is a direct ERC-20 transfer (no LI.FI). Everything else routes through
 * LI.FI Composer with the recipient as `toAddress` so USDC lands in
 * their wallet on Base in a single signature.
 */
import { useEffect, useMemo, useState } from "react";
import { useWallets } from "@privy-io/react-auth";
import { authedFetch } from "@/lib/clientFetch";
import { useSendFlow, type SendSource } from "@/hooks/useSendFlow";
import { CopyProgressDialog } from "@/components/win98/CopyProgressDialog";
import { BASE_CHAIN_ID, USDC_BASE } from "@/lib/constants";
import { shortAddr } from "@/lib/format";

type Holding = {
  chainId: number;
  chainName: string;
  token: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;
  balanceFormatted: string;
  valueUSD: number;
};

type HoldingsResponse = { holdings: Holding[] };

export type SendDialogProps = {
  open: boolean;
  onClose: () => void;
  recipientAddress: `0x${string}`;
  recipientLabel: string;
};

export function SendDialog({
  open,
  onClose,
  recipientAddress,
  recipientLabel,
}: SendDialogProps) {
  const { wallets } = useWallets();
  const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];

  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [holdingsError, setHoldingsError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [amount, setAmount] = useState("");
  const flow = useSendFlow();

  // Reset when opening / closing.
  useEffect(() => {
    if (!open) {
      setHoldings(null);
      setHoldingsError(null);
      setSelectedKey("");
      setAmount("");
      return;
    }
    if (!wallet) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch<HoldingsResponse>(
          `/api/wallet/holdings?address=${wallet.address}`,
        );
        if (cancelled) return;
        setHoldings(res.holdings);
        // Default-select Base USDC if the user has it, else first item.
        const baseUsdc = res.holdings.find(
          (h) =>
            h.chainId === BASE_CHAIN_ID &&
            h.token.toLowerCase() === USDC_BASE.toLowerCase(),
        );
        const pick = baseUsdc ?? res.holdings[0];
        if (pick) setSelectedKey(`${pick.chainId}:${pick.token}`);
      } catch (e) {
        if (!cancelled) setHoldingsError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [open, wallet]);

  const selected = useMemo(() => {
    if (!holdings || !selectedKey) return null;
    return holdings.find((h) => `${h.chainId}:${h.token}` === selectedKey) ?? null;
  }, [holdings, selectedKey]);

  const isDirectBaseUsdc =
    selected?.chainId === BASE_CHAIN_ID &&
    selected?.token.toLowerCase() === USDC_BASE.toLowerCase();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet) return;
    if (!selected) return;
    const source: SendSource = {
      label: `${selected.symbol} on ${selected.chainName}`,
      chainId: selected.chainId,
      token: selected.token as `0x${string}`,
      decimals: selected.decimals,
      symbol: selected.symbol,
    };
    await flow.execute({
      source,
      amount,
      wallet,
      recipientAddress,
      recipientLabel,
    });
  }

  function handleMax() {
    if (selected) setAmount(selected.balanceFormatted);
  }

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 flex items-center justify-center"
        style={{ background: "rgba(0,0,0,0.35)", zIndex: 50 }}
        role="dialog"
        aria-modal="true"
        aria-label="Send funds"
      >
        <div className="window" style={{ width: 480, maxWidth: "94vw" }}>
          <div className="title-bar">
            <div className="title-bar-text">Send → {recipientLabel}</div>
            <div className="title-bar-controls">
              <button aria-label="Close" onClick={onClose} />
            </div>
          </div>
          <div className="window-body">
            <form onSubmit={onSubmit} className="flex flex-col gap-3">
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                Recipient:{" "}
                <code style={{ fontSize: 11 }}>{shortAddr(recipientAddress)}</code>
              </div>

              <div className="field-row-stacked" style={{ gap: 4 }}>
                <label htmlFor="send-holding">From token</label>
                {holdingsError && (
                  <div className="betpal-alert betpal-alert--error">
                    {holdingsError}
                  </div>
                )}
                {!holdings && !holdingsError && (
                  <p style={{ opacity: 0.6 }}>Loading holdings…</p>
                )}
                {holdings && holdings.length === 0 && (
                  <div className="betpal-alert">
                    No tokens in your wallet across supported chains. Top up
                    USDC on Base and try again.
                  </div>
                )}
                {holdings && holdings.length > 0 && (
                  <select
                    id="send-holding"
                    value={selectedKey}
                    onChange={(e) => setSelectedKey(e.target.value)}
                  >
                    {holdings.map((h) => (
                      <option
                        key={`${h.chainId}:${h.token}`}
                        value={`${h.chainId}:${h.token}`}
                      >
                        {h.symbol} on {h.chainName} — {h.balanceFormatted} ($
                        {h.valueUSD.toFixed(2)})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="field-row-stacked" style={{ gap: 4 }}>
                <label htmlFor="send-amount">
                  Amount {selected ? `(${selected.symbol})` : ""}
                </label>
                <div style={{ display: "flex", gap: 4 }}>
                  <input
                    id="send-amount"
                    type="text"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    style={{ flex: 1 }}
                  />
                  <button type="button" onClick={handleMax} disabled={!selected}>
                    Max
                  </button>
                </div>
                {selected && (
                  <small style={{ opacity: 0.7 }}>
                    Available: {selected.balanceFormatted} {selected.symbol}
                  </small>
                )}
              </div>

              <div
                style={{
                  fontSize: 11,
                  opacity: 0.75,
                  padding: 6,
                  background: "#f7f7f0",
                  border: "1px solid #d8d8c8",
                }}
              >
                {isDirectBaseUsdc
                  ? "Same-chain USDC transfer on Base. One signature, no LI.FI fees."
                  : "Cross-chain or non-USDC source → LI.FI Composer will route this to USDC on Base and deliver it straight to the recipient in one signature."}
              </div>

              <div className="flex gap-2 justify-end">
                <button type="button" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    !wallet ||
                    !selected ||
                    !amount ||
                    Number(amount) <= 0 ||
                    flow.open
                  }
                >
                  Send
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>

      <CopyProgressDialog
        open={flow.open}
        title="Sending funds…"
        status={
          flow.error
            ? `Failed: ${flow.error}`
            : flow.txHash
              ? `${flow.status} Tx: ${flow.txHash.slice(0, 14)}…`
              : flow.status
        }
        progress={flow.progress}
        fromLabel={selected ? `${selected.symbol} on ${selected.chainName}` : undefined}
        toLabel={recipientLabel}
        onClose={() => {
          flow.reset();
          if (!flow.error) onClose();
        }}
        onCancel={flow.error ? () => flow.reset() : undefined}
      />
    </>
  );
}
