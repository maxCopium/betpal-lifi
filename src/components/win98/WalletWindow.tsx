"use client";

/**
 * <WalletWindow> — Win98 draggable window showing the connected Privy
 * wallet address and all token balances on Base (via LI.FI).
 */
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { DraggableWindow } from "./DraggableWindow";
import { useWalletBalances } from "@/hooks/useWalletBalances";

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

export function WalletWindow() {
  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { balances, loading, refresh } = useWalletBalances();

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

  return (
    <DraggableWindow
      id="wallet"
      title="My Wallet"
      defaultPosition={{ x: 0, y: 0 }}
    >
      {!authenticated ? (
        <div className="flex flex-col gap-3">
          <p>Sign in to view your wallet.</p>
          <button onClick={() => login()}>Sign in</button>
        </div>
      ) : !wallet ? (
        <p style={{ opacity: 0.6 }}>Loading wallet…</p>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Address */}
          <div className="flex items-center justify-between" style={{ padding: "4px 0", borderBottom: "1px solid #dfdfdf" }}>
            <span style={{ color: "#666" }}>Address</span>
            <code style={{ fontSize: 12, letterSpacing: "0.5px" }}>{shortenAddr(wallet.address)}</code>
          </div>

          {/* Total balance */}
          <div style={{ textAlign: "center", padding: "12px 0" }}>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.5px" }}>
              ${totalUsd.toFixed(2)}
            </div>
            <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>Total balance</div>
          </div>

          {/* Token list */}
          {loading && balances.length === 0 && (
            <p style={{ opacity: 0.6, textAlign: "center" }}>Loading…</p>
          )}
          {!loading && balances.length === 0 && (
            <p style={{ opacity: 0.6, textAlign: "center", fontStyle: "italic" }}>
              No funds yet.
            </p>
          )}
          {balances.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #ccc" }}>
                  <th style={{ textAlign: "left", fontWeight: 600, padding: "4px 0" }}>Token</th>
                  <th style={{ textAlign: "right", fontWeight: 600, padding: "4px 6px" }}>Amount</th>
                  <th style={{ textAlign: "right", fontWeight: 600, padding: "4px 0" }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {balances.map((t) => {
                  const isStable = ["USDC", "USDbC", "DAI", "USDT"].includes(t.symbol);
                  const formatted = trimDecimals(t.balanceFormatted, isStable ? 2 : 6);
                  const usdVal = t.priceUSD
                    ? (Number(t.priceUSD) * Number(t.balanceFormatted)).toFixed(2)
                    : null;
                  return (
                    <tr key={t.address} style={{ borderBottom: "1px solid #eee" }}>
                      <td style={{ padding: "6px 0", fontWeight: 600 }}>{t.symbol}</td>
                      <td style={{ padding: "6px 6px", textAlign: "right" }}>{formatted}</td>
                      <td style={{ padding: "6px 0", textAlign: "right", color: "#666" }}>
                        {usdVal ? `$${usdVal}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Actions */}
          <div className="flex gap-2" style={{ marginTop: 4 }}>
            <button onClick={openFunding} style={{ flex: 1 }}>
              Add funds
            </button>
            <button onClick={() => refresh()} disabled={loading} style={{ flex: 1 }}>
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
          <button onClick={() => window.open("https://home.privy.io/", "betpal_fund")}>
            Manage wallet
          </button>
        </div>
      )}
    </DraggableWindow>
  );
}
