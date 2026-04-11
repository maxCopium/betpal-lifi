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
        <div className="flex flex-col gap-2" style={{ padding: 4 }}>
          <p className="text-xs">Sign in to view your wallet.</p>
          <button onClick={() => login()}>Sign in</button>
        </div>
      ) : !wallet ? (
        <p className="text-xs" style={{ padding: 4 }}>Loading wallet…</p>
      ) : (
        <div className="flex flex-col gap-2" style={{ padding: 4 }}>
          {/* Address */}
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "#666" }}>Address</span>
            <code style={{ fontSize: 11 }}>{shortenAddr(wallet.address)}</code>
          </div>

          {/* Total balance */}
          <div
            style={{
              textAlign: "center",
              padding: "6px 0",
              borderBottom: "1px solid #dfdfdf",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              ${totalUsd.toFixed(2)}
            </div>
            <div style={{ fontSize: 10, color: "#666" }}>Total balance</div>
          </div>

          {/* Token list */}
          {loading && balances.length === 0 && (
            <p className="text-xs" style={{ color: "#666" }}>Loading…</p>
          )}
          {!loading && balances.length === 0 && (
            <p className="text-xs" style={{ color: "#666" }}>
              No funds yet.
            </p>
          )}
          {balances.length > 0 && (
            <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
              <tbody>
                {balances.map((t) => {
                  const isStable = ["USDC", "USDbC", "DAI", "USDT"].includes(t.symbol);
                  const formatted = trimDecimals(t.balanceFormatted, isStable ? 2 : 6);
                  const usdVal = t.priceUSD
                    ? (Number(t.priceUSD) * Number(t.balanceFormatted)).toFixed(2)
                    : null;
                  return (
                    <tr key={t.address} style={{ borderBottom: "1px solid #dfdfdf" }}>
                      <td style={{ padding: "2px 0", fontWeight: 600 }}>{t.symbol}</td>
                      <td style={{ padding: "2px 4px", textAlign: "right" }}>{formatted}</td>
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

          {/* Actions */}
          <div className="flex gap-2" style={{ marginTop: 4 }}>
            <button onClick={openFunding} style={{ flex: 1 }}>
              Add funds
            </button>
            <button onClick={() => refresh()} disabled={loading} style={{ flex: 1 }}>
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
          <button
            onClick={() => window.open("https://home.privy.io/", "betpal_fund")}
            style={{ fontSize: 10 }}
          >
            Manage wallet
          </button>
        </div>
      )}
    </DraggableWindow>
  );
}
