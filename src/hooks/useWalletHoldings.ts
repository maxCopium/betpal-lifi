"use client";

import { useState, useEffect } from "react";
import { useWallets } from "@privy-io/react-auth";
import { authedFetch } from "@/lib/clientFetch";

export type Holding = {
  chainId: number;
  chainName: string;
  token: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;
  balanceFormatted: string;
  logoURI?: string;
  priceUSD?: string;
  valueUSD: number;
};

/**
 * Fetches the user's token holdings across multiple chains via /api/wallet/holdings.
 * Used for "Pay from" selector — shows only tokens the user actually owns.
 */
export function useWalletHoldings() {
  const { wallets } = useWallets();
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(true);

  const wallet =
    wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];

  useEffect(() => {
    if (!wallet?.address) {
      setHoldings([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const json = await authedFetch<{ holdings: Holding[] }>(
          `/api/wallet/holdings?address=${wallet.address}`,
        );
        if (!cancelled) setHoldings(json.holdings);
      } catch (err) {
        console.error("[useWalletHoldings] failed:", (err as Error).message);
        if (!cancelled) setHoldings([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [wallet?.address]);

  return { holdings, loading };
}
