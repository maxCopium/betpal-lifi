import "server-only";
import { errorResponse, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { isMockMarket, getMockMarketData } from "@/lib/polymarket";

/**
 * GET /api/bets/active
 *
 * List active (non-settled) bets the caller participates in, with mock
 * market metadata for the taskbar resolve button.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const me = await requireUser(request);
    const sb = supabaseService();

    // Find bets where the user has a stake, that aren't settled/voided.
    const { data, error } = await sb
      .from("stakes")
      .select("bet_id, bet:bets!inner(id, polymarket_market_id, question, status)")
      .eq("user_id", me.id)
      .in("bet.status", ["open", "locked", "resolving"]);
    if (error) throw error;

    // Deduplicate by bet_id and enrich with mock market data.
    const seen = new Set<string>();
    const bets = [];
    for (const row of data ?? []) {
      const bet = Array.isArray(row.bet) ? row.bet[0] : row.bet;
      if (!bet || seen.has(bet.id as string)) continue;
      seen.add(bet.id as string);

      const marketId = bet.polymarket_market_id as string;
      const mock = isMockMarket(marketId) ? getMockMarketData(marketId) : null;
      bets.push({
        id: bet.id as string,
        question: (bet.question as string) || mock?.question || marketId,
        outcomes: mock?.outcomes
          ? (Array.isArray(mock.outcomes) ? mock.outcomes : JSON.parse(mock.outcomes as string))
          : ["Yes", "No"],
        status: bet.status as string,
        isMock: isMockMarket(marketId),
      });
    }

    return Response.json({ bets });
  } catch (e) {
    return errorResponse(e);
  }
}
