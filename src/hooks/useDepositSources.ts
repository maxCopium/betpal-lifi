"use client";

import { useState, useEffect } from "react";
import type { DepositSource } from "@/app/api/deposit-sources/route";

/**
 * Fetches available deposit sources from /api/deposit-sources.
 * These are dynamically validated via LI.FI /v1/chains + /v1/connections.
 *
 * Falls back to hardcoded defaults if the API fails (hackathon resilience).
 */

const FALLBACK_SOURCES: DepositSource[] = [
  {
    chainId: 8453,
    chainName: "Base",
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    decimals: 6,
  },
  {
    chainId: 137,
    chainName: "Polygon",
    token: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    symbol: "USDC",
    decimals: 6,
  },
];

export function useDepositSources(toToken?: string) {
  const [sources, setSources] = useState<DepositSource[]>(FALLBACK_SOURCES);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({ toChain: "8453" });
        if (toToken) params.set("toToken", toToken);
        const res = await fetch(`/api/deposit-sources?${params}`);
        if (!res.ok) throw new Error("fetch failed");
        const json = (await res.json()) as { sources: DepositSource[] };
        if (!cancelled && json.sources.length > 0) {
          setSources(json.sources);
        }
      } catch {
        // keep fallback
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [toToken]);

  return { sources, loading };
}
