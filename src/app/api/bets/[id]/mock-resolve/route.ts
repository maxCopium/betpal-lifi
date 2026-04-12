import "server-only";
import { z } from "zod";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { resolveBetIfPossible } from "@/lib/resolveBet";

/**
 * POST /api/bets/[id]/mock-resolve
 *
 * Manually resolve ANY bet for demo purposes. Works with both real
 * Polymarket markets and mock markets. Sets mock_resolved_outcome on the
 * bet, then triggers resolution which uses that outcome directly.
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

    const { data: bet, error: betErr } = await sb
      .from("bets")
      .select("id, options, status")
      .eq("id", betId)
      .maybeSingle();
    if (betErr) throw new HttpError(500, `bet lookup failed: ${betErr.message}`);
    if (!bet) throw new HttpError(404, "bet not found");
    if (bet.status === "settled" || bet.status === "voided") {
      throw new HttpError(409, `bet already ${bet.status}`);
    }

    // Validate outcome against the bet's options.
    const options = Array.isArray(bet.options) ? bet.options as string[] : [];
    if (options.length > 0 && !options.includes(body.outcome)) {
      throw new HttpError(400, `invalid outcome — valid: ${options.join(", ")}`);
    }

    // Set the manual resolved outcome.
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
