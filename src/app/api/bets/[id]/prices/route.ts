import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { getMarket, isMockMarket, getMockMarketData } from "@/lib/polymarket";

/**
 * GET /api/bets/:id/prices
 *
 * Returns live Polymarket outcome prices for the bet's linked market.
 * Prices are decimals 0-1, representing probability (e.g. 0.65 = 65%).
 *
 * Response: { outcomes: string[], prices: number[], closed: boolean }
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireUser(request);
    const { id: betId } = await params;

    const sb = supabaseService();
    const { data: bet, error: betErr } = await sb
      .from("bets")
      .select("polymarket_market_id, options")
      .eq("id", betId)
      .maybeSingle();
    if (betErr) throw new HttpError(500, betErr.message);
    if (!bet) throw new HttpError(404, "bet not found");

    const marketId = bet.polymarket_market_id as string;
    let outcomes: string[] = [];
    let prices: number[] = [];
    let closed = false;

    if (isMockMarket(marketId)) {
      const mock = getMockMarketData(marketId);
      if (mock) {
        outcomes = Array.isArray(mock.outcomes)
          ? mock.outcomes.map(String)
          : JSON.parse(mock.outcomes as string);
        prices = Array.isArray(mock.outcomePrices)
          ? mock.outcomePrices.map(Number)
          : JSON.parse(mock.outcomePrices as string).map(Number);
        closed = mock.closed ?? false;
      }
    } else {
      const market = await getMarket(marketId);
      outcomes = parseArr(market.outcomes) ?? (bet.options as string[]);
      prices = (parseArr(market.outcomePrices) ?? []).map(Number);
      closed = market.closed ?? false;
    }

    return Response.json({ outcomes, prices, closed });
  } catch (e) {
    return errorResponse(e);
  }
}

function parseArr(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : null;
    } catch {
      return null;
    }
  }
  return null;
}
