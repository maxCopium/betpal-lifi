import "server-only";
import { z } from "zod";

/**
 * Polymarket Gamma API wrapper.
 * Base: https://gamma-api.polymarket.com
 * Public, no auth.
 *
 * Polymarket is BetPal's ORACLE, not its venue. We never buy positions there;
 * we only read the resolution status. We pay out only on `resolved` (after the
 * UMA dispute window), never on `closed`.
 */

const GAMMA = "https://gamma-api.polymarket.com";

// The exact resolution-status field shape needs verification on Day 0.
// Below is a tolerant schema that accepts the documented fields and stashes
// the rest in `passthrough()` so we don't crash on field renames.
const MarketSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    question: z.string(),
    slug: z.string().optional(),
    description: z.string().optional(),
    closed: z.boolean().optional(),
    active: z.boolean().optional(),
    archived: z.boolean().optional(),
    endDate: z.string().optional(),
    outcomes: z.union([z.array(z.string()), z.string()]).optional(),
    outcomePrices: z.union([z.array(z.string()), z.string()]).optional(),
    // Resolution-side fields (verify exact names on Day 0):
    umaResolutionStatus: z.string().optional(),
    resolvedBy: z.string().optional(),
    acceptingOrders: z.boolean().optional(),
  })
  .passthrough();

export type PolymarketMarket = z.infer<typeof MarketSchema>;

export async function searchMarkets(query: string, limit = 20): Promise<PolymarketMarket[]> {
  const url = new URL(`${GAMMA}/markets`);
  url.searchParams.set("limit", String(limit));
  if (query) url.searchParams.set("search", query);
  const res = await fetch(url.toString(), {
    headers: { accept: "application/json" },
    next: { revalidate: 60 },
  });
  if (!res.ok) {
    throw new Error(`Polymarket /markets failed: ${res.status}`);
  }
  const json = await res.json();
  const arr = Array.isArray(json) ? json : (json.data ?? []);
  return z.array(MarketSchema).parse(arr);
}

export async function getMarket(marketId: string): Promise<PolymarketMarket> {
  const res = await fetch(`${GAMMA}/markets/${marketId}`, {
    headers: { accept: "application/json" },
    next: { revalidate: 30 },
  });
  if (!res.ok) {
    throw new Error(`Polymarket /markets/${marketId} failed: ${res.status}`);
  }
  return MarketSchema.parse(await res.json());
}

/**
 * Decide whether a market is RESOLVED for BetPal's purposes.
 *
 * Rules (locked decision #4):
 *   - Must be `closed === true` AND have a definitive winning outcome.
 *   - Must wait for the UMA dispute window to elapse (we add a 2-hour buffer
 *     beyond the closure timestamp before paying out).
 *   - If umaResolutionStatus is present, prefer it as the authoritative signal.
 *
 * The exact field shape is finalized in the Day 0 verification curl. This
 * function is the seam.
 */
export function isMarketSettleable(
  m: PolymarketMarket,
  now: Date = new Date(),
): { settleable: boolean; winningOutcome?: string; reason?: string } {
  if (!m.closed) return { settleable: false, reason: "not closed" };

  // Require UMA resolution to be complete. The `umaResolutionStatus` field is
  // absent on open markets and set to "resolved" after the dispute window. If
  // the field is present but NOT "resolved" (e.g. "proposed"), the market is
  // still in the UMA dispute window — settling now would risk paying out on a
  // result that gets overturned.
  if (m.umaResolutionStatus !== undefined && m.umaResolutionStatus !== "resolved") {
    return { settleable: false, reason: `UMA status: ${m.umaResolutionStatus}` };
  }

  // Buffer past closure (heuristic fallback when umaResolutionStatus is absent)
  if (m.endDate) {
    const end = new Date(m.endDate).getTime();
    const bufferMs = 2 * 60 * 60 * 1000;
    if (now.getTime() < end + bufferMs) {
      return { settleable: false, reason: "within dispute buffer" };
    }
  }
  // Pick winning outcome from outcomePrices (the side with price ~1.0)
  const outcomes = parseStringArray(m.outcomes);
  const prices = parseStringArray(m.outcomePrices)?.map(Number);
  if (!outcomes || !prices || outcomes.length !== prices.length) {
    return { settleable: false, reason: "missing outcome data" };
  }
  const maxIdx = prices.indexOf(Math.max(...prices));
  if (prices[maxIdx] < 0.99) {
    return { settleable: false, reason: "no decisive outcome price" };
  }
  return { settleable: true, winningOutcome: outcomes[maxIdx] };
}

function parseStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
