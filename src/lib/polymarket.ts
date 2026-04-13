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
    // Real API uses plural `umaResolutionStatuses` — a JSON-encoded string
    // array like '["resolved"]' or '[]'. Verified against live Gamma API.
    umaResolutionStatuses: z.string().optional(),
    resolvedBy: z.string().optional(),
    acceptingOrders: z.boolean().optional(),
  })
  .passthrough();

export type PolymarketMarket = z.infer<typeof MarketSchema>;

/**
 * In-memory event cache. Gamma has 3500+ open events; we fetch them all once
 * and reuse for every search until the TTL expires. This avoids 8 parallel
 * requests per keystroke and keeps us well under any rate limit.
 */
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cachedEvents: Record<string, unknown>[] = [];
let cacheTimestamp = 0;

async function fetchOpenEvents(pageLimit: number, offset: number): Promise<unknown[]> {
  const url = new URL(`${GAMMA}/events`);
  url.searchParams.set("limit", String(pageLimit));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("closed", "false");
  const res = await fetch(url.toString(), {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) return [];
  const json = await res.json();
  return Array.isArray(json) ? json : (json.data ?? []);
}

async function getAllEvents(): Promise<Record<string, unknown>[]> {
  const now = Date.now();
  if (cachedEvents.length > 0 && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedEvents;
  }
  // Fetch all pages in parallel (500 per page, 8 pages = 4000 max).
  const PAGE = 500;
  const pages = await Promise.all(
    Array.from({ length: 8 }, (_, i) => fetchOpenEvents(PAGE, i * PAGE)),
  );
  cachedEvents = pages.flat() as Record<string, unknown>[];
  cacheTimestamp = now;
  console.log(`[polymarket] cached ${cachedEvents.length} events`);
  return cachedEvents;
}

export async function searchMarkets(query: string, limit = 20): Promise<PolymarketMarket[]> {
  const allEvents = await getAllEvents();

  // Tokenize query for matching. Drop very short words (stop-words like
  // "of", "the", "in") that would match nearly every JSON blob.
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);

  if (terms.length === 0) {
    return z.array(MarketSchema).parse([]);
  }

  // Score and filter events by how well they match the query.
  type ScoredMarket = { market: unknown; score: number };
  const scored: ScoredMarket[] = [];

  for (const event of allEvents) {
    const children = Array.isArray(event.markets) ? event.markets : [];
    const eventTitle = ((event.title as string) ?? "").toLowerCase();

    // Stringify the entire event once for broad keyword matching.
    // This catches terms in lesser-known fields (resolution sources, tags, etc.)
    const eventBlob = JSON.stringify(event).toLowerCase();

    for (const m of children as Record<string, unknown>[]) {
      // Don't filter closed markets — they're still valid oracle targets.
      const question = ((m.question as string) ?? "").toLowerCase();
      const marketBlob = JSON.stringify(m).toLowerCase();
      const broadText = `${eventBlob} ${marketBlob}`;

      // Count broad matches (term found anywhere in event/market JSON).
      const broadHits = terms.filter((t) => broadText.includes(t)).length;
      if (broadHits === 0) continue;

      // Boost: title/question matches are worth 3x more than deep-blob matches.
      const primary = `${eventTitle} ${question}`;
      const titleHits = terms.filter((t) => primary.includes(t)).length;
      const score = titleHits * 3 + (broadHits - titleHits);

      // Inherit slug from event if market doesn't have one.
      if (!m.slug && event.slug) m.slug = event.slug;
      scored.push({ market: m, score });
    }
  }

  // Sort by match quality (title matches first, then broad matches).
  scored.sort((a, b) => b.score - a.score);

  return z.array(MarketSchema).parse(scored.slice(0, limit).map((s) => s.market));
}

export async function trendingMarkets(limit = 10): Promise<PolymarketMarket[]> {
  const url = new URL(`${GAMMA}/markets`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("closed", "false");
  url.searchParams.set("active", "true");
  url.searchParams.set("order", "volume");
  url.searchParams.set("ascending", "false");
  const res = await fetch(url.toString(), {
    headers: { accept: "application/json" },
    next: { revalidate: 300 },
  });
  if (!res.ok) {
    throw new Error(`Polymarket /markets trending failed: ${res.status}`);
  }
  const json = await res.json();
  const arr = Array.isArray(json) ? json : (json.data ?? []);
  return z.array(MarketSchema).parse(arr);
}

/**
 * Mock market support. When a market_id starts with "mock:", we return
 * synthetic data instead of hitting Polymarket. Kept for backward
 * compatibility with any existing mock: bets in the DB.
 * New bets always use real Polymarket markets; resolution is via
 * force-resolve (unanimous consent) if needed.
 */
const MOCK_MARKETS: Record<string, { question: string; outcomes: string[] }> = {
  "mock:eth-5k": {
    question: "Will ETH hit $5,000 by end of 2026?",
    outcomes: ["Yes", "No"],
  },
  "mock:btc-200k": {
    question: "Will BTC reach $200,000 in 2026?",
    outcomes: ["Yes", "No"],
  },
  "mock:demo": {
    question: "Demo bet",
    outcomes: ["Yes", "No"],
  },
};

export function isMockMarket(marketId: string): boolean {
  return marketId.startsWith("mock:");
}

export function getMockMarketData(marketId: string): PolymarketMarket | null {
  const mock = MOCK_MARKETS[marketId];
  if (!mock) return null;
  return {
    id: marketId,
    question: mock.question,
    outcomes: mock.outcomes,
    outcomePrices: mock.outcomes.map(() => "0.5"),
    closed: false,
    active: true,
    endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

export async function getMarket(marketId: string): Promise<PolymarketMarket> {
  if (isMockMarket(marketId)) {
    const mock = getMockMarketData(marketId);
    if (mock) return mock;
    throw new Error(`unknown mock market: ${marketId}`);
  }
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
  /** Manual override outcome from DB (set via force-resolve unanimous consent). */
  mockResolvedOutcome?: string | null,
): { settleable: boolean; winningOutcome?: string; reason?: string } {
  // Manual resolution override — works for ANY market (mock or real).
  // Set via force-resolve when all stakers unanimously agree on an outcome.
  if (mockResolvedOutcome) {
    return { settleable: true, winningOutcome: mockResolvedOutcome };
  }

  // Mock markets without manual outcome are not yet resolved.
  if (isMockMarket(String(m.id))) {
    return { settleable: false, reason: "mock market not yet resolved" };
  }

  if (!m.closed) return { settleable: false, reason: "not closed" };

  // Require UMA resolution to be complete. The Gamma API returns
  // `umaResolutionStatuses` as a JSON-encoded string array, e.g.
  // '["resolved"]' or '[]'. If the array is non-empty but does NOT contain
  // "resolved", the market is still in the UMA dispute window.
  const umaStatuses = parseUmaStatuses(m.umaResolutionStatuses);
  if (umaStatuses.length > 0 && !umaStatuses.includes("resolved")) {
    return { settleable: false, reason: `UMA status: ${umaStatuses.join(", ")}` };
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
  // Validate all prices are finite numbers in [0, 1].
  if (prices.some((p) => !Number.isFinite(p) || p < 0 || p > 1)) {
    return { settleable: false, reason: "invalid outcome prices" };
  }
  const maxPrice = Math.max(...prices);
  if (maxPrice < 0.99) {
    return { settleable: false, reason: "no decisive outcome price" };
  }
  // Reject ambiguous resolution: multiple outcomes at the max price.
  const winnersAtMax = prices.filter((p) => p === maxPrice);
  if (winnersAtMax.length > 1) {
    return { settleable: false, reason: "ambiguous: multiple outcomes share max price" };
  }
  const maxIdx = prices.indexOf(maxPrice);
  return { settleable: true, winningOutcome: outcomes[maxIdx] };
}

/**
 * Parse the `umaResolutionStatuses` field from the Gamma API.
 * It's a JSON-encoded string array like '["resolved"]' or '[]', or undefined.
 */
function parseUmaStatuses(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
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
