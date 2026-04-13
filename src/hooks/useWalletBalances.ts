"use client";

import { useState, useCallback, useEffect } from "react";
import { useWallets } from "@privy-io/react-auth";
import { authedFetch } from "@/lib/clientFetch";

export type TokenBalance = {
  symbol: string;
  name: string;
  address: string;
  balance: string;
  balanceFormatted: string;
  decimals: number;
  logoURI?: string;
  priceUSD?: string;
};

/**
 * Fetches all non-zero token balances for the user's Privy wallet on Base.
 * Calls /api/wallet/balance which uses LI.FI /v1/tokens + multicall.
 */
export function useWalletBalances() {
  const { wallets } = useWallets();
  const [balances, setBalances] = useState<TokenBalance[]>([]);
  const [loading, setLoading] = useState(false);

  const wallet =
    wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];

  const refresh = useCallback(async () => {
    if (!wallet?.address) {
      setBalances([]);
      return;
    }
    setLoading(true);
    try {
      const json = await authedFetch<{ balances: TokenBalance[] }>(
        `/api/wallet/balance?address=${wallet.address}`,
      );
      setBalances(json.balances);
    } catch {
      setBalances([]);
    } finally {
      setLoading(false);
    }
  }, [wallet?.address]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { balances, loading, refresh };
}
