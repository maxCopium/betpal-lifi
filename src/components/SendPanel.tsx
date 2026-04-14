"use client";

/**
 * SendPanel — inline wallet-to-wallet send form for the My Account sidebar.
 *
 * Unlike SendDialog this is NOT a modal — it renders inline in the sidebar
 * (same pattern as the username edit in LoginButton). Fields: recipient
 * address, source holding (token + chain), amount. Routes through
 * useSendFlow which picks direct ERC-20 transfer on Base USDC or the LI.FI
 * Composer path for everything else.
 */
import { useEffect, useMemo, useState } from "react";
import { useWallets } from "@privy-io/react-auth";
import { authedFetch } from "@/lib/clientFetch";
import { useSendFlow, type SendSource } from "@/hooks/useSendFlow";
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

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

export function SendPanel({ onClose }: { onClose: () => void }) {
  const { wallets } = useWallets();
  const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];

  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [holdingsError, setHoldingsError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const flow = useSendFlow();

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch<HoldingsResponse>(
          `/api/wallet/holdings?address=${wallet.address}`,
        );
        if (cancelled) return;
        setHoldings(res.holdings);
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
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  const selected = useMemo(() => {
    if (!holdings || !selectedKey) return null;
    return (
      holdings.find((h) => `${h.chainId}:${h.token}` === selectedKey) ?? null
    );
  }, [holdings, selectedKey]);

  const recipientValid = ADDR_RE.test(recipient.trim());
  const recipientAddr = recipientValid
    ? (recipient.trim() as `0x${string}`)
    : null;

  const isDirectBaseUsdc =
    selected?.chainId === BASE_CHAIN_ID &&
    selected?.token.toLowerCase() === USDC_BASE.toLowerCase();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet || !selected || !recipientAddr) return;
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
      recipientAddress: recipientAddr,
      recipientLabel: shortAddr(recipientAddr),
    });
  }

  function handleMax() {
    if (selected) setAmount(selected.balanceFormatted);
  }

  const busy = flow.open && !flow.error;
  const done = flow.progress === 100 || (flow.txHash && !flow.error);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 6,
        background: "#f7f7f0",
        border: "1px solid #d8d8c8",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>Send funds</strong>
        <button
          type="button"
          onClick={() => {
            flow.reset();
            onClose();
          }}
          title="Close"
          aria-label="Close"
          style={{
            minHeight: 0,
            minWidth: 0,
            width: 22,
            height: 22,
            padding: 0,
            fontSize: 11,
            lineHeight: 1,
            overflow: "visible",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            boxSizing: "border-box",
          }}
        >
          ×
        </button>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col" style={{ gap: 6 }}>
        <div className="field-row-stacked" style={{ gap: 2 }}>
          <label htmlFor="sp-recipient" style={{ fontSize: 11 }}>Recipient</label>
          <input
            id="sp-recipient"
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
            autoComplete="off"
            style={{ fontSize: 11 }}
          />
          {recipient && !recipientValid && (
            <small style={{ color: "#c00", fontSize: 10 }}>Not a valid address</small>
          )}
        </div>

        <div className="field-row-stacked" style={{ gap: 2 }}>
          <label htmlFor="sp-holding" style={{ fontSize: 11 }}>Token / chain</label>
          {holdingsError && (
            <div className="betpal-alert betpal-alert--error" style={{ fontSize: 11 }}>
              {holdingsError}
            </div>
          )}
          {!holdings && !holdingsError && (
            <p style={{ opacity: 0.6, fontSize: 11, margin: 0 }}>Loading…</p>
          )}
          {holdings && holdings.length === 0 && (
            <div className="betpal-alert" style={{ fontSize: 11 }}>
              No tokens in wallet.
            </div>
          )}
          {holdings && holdings.length > 0 && (
            <select
              id="sp-holding"
              value={selectedKey}
              onChange={(e) => setSelectedKey(e.target.value)}
              style={{ fontSize: 11 }}
            >
              {holdings.map((h) => (
                <option
                  key={`${h.chainId}:${h.token}`}
                  value={`${h.chainId}:${h.token}`}
                >
                  {h.symbol} · {h.chainName} — {h.balanceFormatted}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="field-row-stacked" style={{ gap: 2 }}>
          <label htmlFor="sp-amount" style={{ fontSize: 11 }}>
            Amount {selected ? `(${selected.symbol})` : ""}
          </label>
          <div style={{ display: "flex", gap: 4, alignItems: "stretch" }}>
            <input
              id="sp-amount"
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              style={{ flex: 1, fontSize: 11 }}
            />
            <button
              type="button"
              onClick={handleMax}
              disabled={!selected}
              style={{
                fontSize: 10,
                padding: "0 6px",
                minHeight: 0,
                lineHeight: 1,
                alignSelf: "stretch",
              }}
            >
              Max
            </button>
          </div>
          {selected && (
            <small style={{ opacity: 0.7, fontSize: 10 }}>
              Available: {selected.balanceFormatted} {selected.symbol}
            </small>
          )}
        </div>

        <div style={{ fontSize: 10, opacity: 0.7 }}>
          {isDirectBaseUsdc
            ? "Direct USDC transfer on Base."
            : "Routed to USDC on Base via LI.FI Composer."}
        </div>

        {flow.status && (
          <div
            className={`betpal-alert ${flow.error ? "betpal-alert--error" : "betpal-alert--info"}`}
            style={{ fontSize: 11 }}
          >
            {flow.error ? `Failed: ${flow.error}` : flow.status}
            {flow.txHash && !flow.error && (
              <div style={{ fontSize: 10, opacity: 0.8 }}>
                Tx: {flow.txHash.slice(0, 14)}…
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
          {done ? (
            <button
              type="button"
              onClick={() => {
                flow.reset();
                onClose();
              }}
              style={{ fontSize: 11, padding: "2px 8px" }}
            >
              Close
            </button>
          ) : (
            <button
              type="submit"
              disabled={
                !wallet ||
                !selected ||
                !amount ||
                Number(amount) <= 0 ||
                !recipientValid ||
                busy
              }
              style={{ fontSize: 11, padding: "2px 8px" }}
            >
              {busy ? "Sending…" : "Send"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
