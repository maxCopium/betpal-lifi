import "server-only";
import { z } from "zod";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { resolveBetIfPossible } from "@/lib/resolveBet";
import { isMockMarket, getMockMarketData } from "@/lib/polymarket";

/**
 * POST /api/bets/[id]/mock-resolve
 *
 * Manually resolve a mock Polymarket bet for demo purposes.
 * Sets the mock_resolved_outcome on the bet, then triggers resolution.
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */

const Body = z.object({
  outcome: z.string().min(1),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireUser(request);
    const { id: betId } = await params;
    const json = await request.json().catch(() => {
      throw new HttpError(400, "invalid json body");
    });
    const body = Body.parse(json);

    const sb = supabaseService();

    // Fetch bet and verify it's a mock market.
    const { data: bet, error: betErr } = await sb
      .from("bets")
      .select("id, polymarket_market_id, status")
      .eq("id", betId)
      .maybeSingle();
    if (betErr) throw new HttpError(500, `bet lookup failed: ${betErr.message}`);
    if (!bet) throw new HttpError(404, "bet not found");

    const marketId = bet.polymarket_market_id as string;
    if (!isMockMarket(marketId)) {
      throw new HttpError(400, "not a mock market — cannot manually resolve");
    }
    if (bet.status === "settled" || bet.status === "voided") {
      throw new HttpError(409, `bet already ${bet.status}`);
    }

    // Validate outcome against market's valid outcomes.
    const mockData = getMockMarketData(marketId);
    if (mockData) {
      const validOutcomes = Array.isArray(mockData.outcomes)
        ? mockData.outcomes
        : [];
      if (validOutcomes.length > 0 && !validOutcomes.includes(body.outcome)) {
        throw new HttpError(400, `invalid outcome — valid: ${validOutcomes.join(", ")}`);
      }
    }

    // Set the mock resolved outcome.
    const { error: updateErr } = await sb
      .from("bets")
      .update({ mock_resolved_outcome: body.outcome })
      .eq("id", betId);
    if (updateErr) throw new HttpError(500, `update failed: ${updateErr.message}`);

    // Trigger resolution.
    const result = await resolveBetIfPossible(betId);

    return Response.json({ betId, outcome: body.outcome, result }, { status: 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
