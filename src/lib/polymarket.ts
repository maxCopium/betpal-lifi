import "server-only";
import { z } from "zod";
import { supabaseService } from "@/lib/supabase";

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
    umaResolutionStatuses: z.string().optional(),
    resolvedBy: z.string().optional(),
    acceptingOrders: z.boolean().optional(),
  })
  .passthrough();

export type PolymarketMarket = z.infer<typeof MarketSchema>;

// ── Search via Supabase polymarket_cache table ────────────────────────

async function fetchOpenEvents(limit: number, offset: number): Promise<unknown[]> {
  const url = new URL(`${GAMMA}/events`);
  url.searchParams.set("limit", String(limit));
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

/**
 * Fetch all open events from Gamma and upsert into polymarket_cache.
 * Called by /api/polymarket/warmup on page load.
 */
export async function warmSearchIndex(): Promise<number> {
  const PAGE = 200;
  const PAGES = 15;
  const pages = await Promise.all(
    Array.from({ length: PAGES }, (_, i) => fetchOpenEvents(PAGE, i * PAGE)),
  );
  const allEvents = pages.flat() as Record<string, unknown>[];

  // Flatten events → market rows for upsert.
  type CacheRow = {
    market_id: string;
    question: string;
    slug: string | null;
    end_date: string | null;
    closed: boolean;
    active: boolean;
    search_text: string;
    updated_at: string;
  };
  const rows: CacheRow[] = [];
  const now = new Date().toISOString();

  for (const event of allEvents) {
    const children = Array.isArray(event.markets) ? event.markets : [];
    const eventTitle = ((event.title as string) ?? "").toLowerCase();
    const eventDesc = ((event.description as string) ?? "").toLowerCase();

    for (const m of children as Record<string, unknown>[]) {
      const id = String(m.id ?? "");
      if (!id) continue;
      const question = ((m.question as string) ?? "");
      const marketDesc = ((m.description as string) ?? "").toLowerCase();
      rows.push({
        market_id: id,
        question,
        slug: (m.slug as string) || (event.slug as string) || null,
        end_date: (m.endDate as string) ?? null,
        closed: !!m.closed,
        active: m.active !== false,
        search_text: `${eventTitle} ${question.toLowerCase()} ${eventDesc} ${marketDesc}`,
        updated_at: now,
      });
    }
  }

  // Upsert in chunks of 500 to stay under payload limits.
  const sb = supabaseService();
  const CHUNK = 500;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb
      .from("polymarket_cache")
      .upsert(chunk, { onConflict: "market_id" });
    if (error) {
      console.error(`[polymarket/warmup] upsert chunk ${i} failed:`, error.message);
    } else {
      upserted += chunk.length;
    }
  }

  console.log(`[polymarket/warmup] upserted ${upserted} markets from ${allEvents.length} events`);
  return upserted;
}

/**
 * Search polymarket_cache using ilike. Instant on any cold start because
 * the data lives in Supabase, not in-memory.
 */
export async function searchMarkets(query: string, limit = 20): Promise<PolymarketMarket[]> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);

  if (terms.length === 0) return [];

  const sb = supabaseService();

  // Build an ilike filter: every term must appear in search_text.
  let q = sb
    .from("polymarket_cache")
    .select("market_id, question, slug, end_date, closed, active")
    .limit(limit);

  for (const term of terms) {
    q = q.ilike("search_text", `%${term}%`);
  }

  const { data, error } = await q;
  if (error) throw new Error(`polymarket search failed: ${error.message}`);
  if (!data || data.length === 0) return [];

  // Map DB rows to PolymarketMarket shape.
  return data.map((row) => ({
    id: row.market_id,
    question: row.question,
    slug: row.slug ?? undefined,
    endDate: row.end_date ?? undefined,
    closed: row.closed,
    active: row.active,
  }));
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
