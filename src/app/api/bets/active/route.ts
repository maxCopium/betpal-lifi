import "server-only";
import { errorResponse, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
/**
 * GET /api/bets/active
 *
 * List active (non-settled) bets the caller participates in.
 * Used by the taskbar resolve button to allow manual resolution for demos.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const me = await requireUser(request);
    const sb = supabaseService();

    // Find bets where the user has a stake, that aren't settled/voided.
    const { data, error } = await sb
      .from("stakes")
      .select("bet_id, bet:bets!inner(id, polymarket_market_id, question, options, status)")
      .eq("user_id", me.id)
      .in("bet.status", ["open", "locked", "resolving"]);
    if (error) throw error;

    const seen = new Set<string>();
    const bets = [];
    for (const row of data ?? []) {
      const bet = Array.isArray(row.bet) ? row.bet[0] : row.bet;
      if (!bet || seen.has(bet.id as string)) continue;
      seen.add(bet.id as string);

      const options = Array.isArray(bet.options) ? bet.options as string[] : ["Yes", "No"];
      bets.push({
        id: bet.id as string,
        question: (bet.question as string) || (bet.polymarket_market_id as string),
        outcomes: options,
        status: bet.status as string,
      });
    }

    return Response.json({ bets });
  } catch (e) {
    return errorResponse(e);
  }
}
