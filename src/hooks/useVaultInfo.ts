"use client";

import { useState, useEffect } from "react";

type VaultInfo = {
  name?: string;
  protocol?: string;
  asset?: string;
  apy: { total: number; base?: number; reward?: number } | null;
  tvl: { usd: number } | null;
};

/**
 * Fetches live vault details (APY, TVL) from /api/earn/vault.
 * Backed by LI.FI Earn /v1/earn/vault endpoint.
 */
export function useVaultInfo(chainId: number, vaultAddress: string) {
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!vaultAddress) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/earn/vault?chainId=${chainId}&address=${vaultAddress}`,
        );
        if (!res.ok) throw new Error("fetch failed");
        const json = (await res.json()) as VaultInfo;
        if (!cancelled) setInfo(json);
      } catch {
        // silent — vault info is optional
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [chainId, vaultAddress]);

  return { info, loading };
}
