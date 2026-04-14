"use client";

/**
 * <SidebarWallet> — compact wallet panel below the Explorer sidebar.
 * Shows address, total balance, token list, and action buttons.
 * Static window (not draggable) — always visible in the left column.
 */
import { useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useWalletBalances } from "@/hooks/useWalletBalances";
import { LoginButton } from "@/app/LoginButton";
import { SendDialog } from "@/app/groups/[id]/SendDialog";

function trimDecimals(val: string, max: number): string {
  const num = Number(val);
  if (isNaN(num)) return val;
  return num.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: max,
  });
}

function shortenAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function SidebarWallet() {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { balances, loading, refresh } = useWalletBalances();
  const [copied, setCopied] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  function copyAddress(addr: string) {
    void navigator.clipboard.writeText(addr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  const wallet =
    wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];

  function openFunding() {
    const w = 480, h = 700;
    const left = window.screenX + (window.innerWidth - w) / 2;
    const top = window.screenY + (window.innerHeight - h) / 2;
    window.open(
      "https://home.privy.io/",
      "betpal_fund",
      `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no,scrollbars=yes`,
    );
  }

  const totalUsd = balances.reduce((sum, t) => {
    const val = t.priceUSD ? Number(t.priceUSD) * Number(t.balanceFormatted) : 0;
    return sum + val;
  }, 0);

  if (!ready) return null;

  return (
    <div className="betpal-sidebar-wallet">
      <div className="window">
        <div className="title-bar">
          <div className="title-bar-text">My Account</div>
        </div>
        <div className="window-body" style={{ padding: "var(--betpal-space-sm)" }}>
          {!authenticated ? (
            <div className="flex flex-col gap-2" style={{ textAlign: "center" }}>
              <p style={{ opacity: 0.6, margin: 0 }}>Sign in to view wallet</p>
              <button onClick={() => login()}>Sign in</button>
            </div>
          ) : !wallet ? (
            <p style={{ opacity: 0.6, margin: 0 }}>Loading…</p>
          ) : (
            <div className="flex flex-col gap-2">
              {/* Identity + sign out */}
              <LoginButton />

              {/* Address */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", opacity: 0.7, fontSize: 12 }}>
                <span>Address</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <code style={{ fontSize: 11 }}>{shortenAddr(wallet.address)}</code>
                  <button
                    type="button"
                    onClick={() => copyAddress(wallet.address)}
                    title={copied ? "Copied!" : "Copy address"}
                    aria-label="Copy address"
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
                    {copied ? "✓" : "⧉"}
                  </button>
                </span>
              </div>

              {/* Total balance */}
              <div style={{ textAlign: "center", padding: "8px 0", borderTop: "1px solid #dfdfdf", borderBottom: "1px solid #dfdfdf" }}>
                <div style={{ fontSize: 20, fontWeight: 700 }}>
                  ${totalUsd.toFixed(2)}
                </div>
              </div>

              {/* Token list — compact */}
              {loading && balances.length === 0 && (
                <p style={{ opacity: 0.6, margin: 0, fontSize: 12 }}>Loading…</p>
              )}
              {!loading && balances.length === 0 && (
                <p style={{ opacity: 0.6, margin: 0, fontSize: 12, fontStyle: "italic" }}>No funds yet</p>
              )}
              {balances.length > 0 && (
                <div style={{ maxHeight: 120, overflowY: "auto" }}>
                  {balances.map((t) => {
                    const isStable = ["USDC", "USDbC", "DAI", "USDT"].includes(t.symbol);
                    const formatted = trimDecimals(t.balanceFormatted, isStable ? 2 : 4);
                    const usdVal = t.priceUSD
                      ? (Number(t.priceUSD) * Number(t.balanceFormatted)).toFixed(2)
                      : null;
                    return (
                      <div
                        key={t.address}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          padding: "3px 0",
                          borderBottom: "1px solid #f0f0f0",
                          fontSize: 12,
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>{t.symbol}</span>
                        <span>
                          {formatted}
                          {usdVal && <span style={{ color: "#666", marginLeft: 4 }}>${usdVal}</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2">
                <button onClick={openFunding} style={{ flex: 1, padding: "3px 6px" }}>
                  + funds
                </button>
                <button
                  onClick={() => setSendOpen(true)}
                  style={{ flex: 1, padding: "3px 6px" }}
                >
                  Send
                </button>
                <button onClick={() => refresh()} disabled={loading} style={{ flex: 1, padding: "3px 6px" }}>
                  {loading ? "…" : "↻"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {sendOpen && (
        <SendDialog open={sendOpen} onClose={() => setSendOpen(false)} />
      )}
    </div>
  );
}
