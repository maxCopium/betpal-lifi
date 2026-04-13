"use client";

import { useState, useEffect } from "react";
import { authedFetch } from "@/lib/clientFetch";
import type { TokenBalance } from "@/hooks/useWalletBalances";

export type Holding = TokenBalance & {
  chainId: number;
  chainName: string;
  valueUSD: number;
};

/**
 * Fetches the user's token holdings for the "Pay from" selector.
 * Reuses the existing /api/wallet/balance endpoint (Base, fast multicall)
 * and enriches with chain info for the deposit flow.
 */
export function useWalletHoldings(walletAddress: string | undefined) {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!walletAddress) {
      setHoldings([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const json = await authedFetch<{ balances: TokenBalance[] }>(
          `/api/wallet/balance?address=${walletAddress}`,
        );
        if (cancelled) return;
        const enriched: Holding[] = json.balances.map((b) => ({
          ...b,
          chainId: 8453,
          chainName: "Base",
          valueUSD: Number(b.priceUSD ?? 0) * Number(b.balanceFormatted),
        }));
        setHoldings(enriched);
      } catch (err) {
        console.error("[useWalletHoldings] failed:", (err as Error).message);
        if (!cancelled) setHoldings([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [walletAddress]);

  return { holdings, loading };
}
