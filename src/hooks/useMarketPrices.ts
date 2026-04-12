"use client";

import { useEffect, useState } from "react";
import { authedFetch } from "@/lib/clientFetch";

type PricesResponse = {
  outcomes: string[];
  prices: number[];
  closed: boolean;
};

/**
 * useMarketPrices — polls live Polymarket outcome prices for a bet.
 * Refreshes every 30s while the bet is open.
 */
export function useMarketPrices(betId: string | null, status?: string) {
  const [data, setData] = useState<PricesResponse | null>(null);

  useEffect(() => {
    if (!betId) return;

    let cancelled = false;

    async function fetchPrices() {
      try {
        const res = await authedFetch<PricesResponse>(`/api/bets/${betId}/prices`);
        if (!cancelled) setData(res);
      } catch {
        // Silently ignore — prices are supplementary
      }
    }

    void fetchPrices();

    // Poll every 30s for open/resolving bets
    const settled = status === "settled" || status === "voided";
    const interval = settled ? null : setInterval(fetchPrices, 30_000);

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [betId, status]);

  return data;
}
