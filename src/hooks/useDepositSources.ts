"use client";

import { useState, useEffect } from "react";
import { authedFetch } from "@/lib/clientFetch";
import type { DepositSource } from "@/app/api/deposit-sources/route";
import {
  BASE_CHAIN_ID, USDC_BASE,
  POLYGON_CHAIN_ID, USDC_POLYGON,
} from "@/lib/constants";

/**
 * Fetches available deposit sources from /api/deposit-sources.
 * These are dynamically validated via LI.FI /v1/chains + /v1/connections.
 *
 * Falls back to hardcoded defaults if the API fails (hackathon resilience).
 */

const FALLBACK_SOURCES: DepositSource[] = [
  {
    chainId: BASE_CHAIN_ID,
    chainName: "Base",
    token: USDC_BASE,
    symbol: "USDC",
    decimals: 6,
  },
  {
    chainId: POLYGON_CHAIN_ID,
    chainName: "Polygon",
    token: USDC_POLYGON,
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
        const params = new URLSearchParams({ toChain: String(BASE_CHAIN_ID) });
        if (toToken) params.set("toToken", toToken);
        const json = await authedFetch<{ sources: DepositSource[] }>(`/api/deposit-sources?${params}`);
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
