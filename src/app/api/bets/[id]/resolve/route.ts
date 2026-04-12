import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { resolveBetIfPossible } from "@/lib/resolveBet";

/**
 * POST /api/bets/[id]/resolve
 *
 * Try to settle a bet. The heavy lifting (Polymarket settleability check,
 * pari-mutuel payout, ledger writes) lives in `src/lib/resolveBet.ts` so the
 * auto-resolution cron can share the same code path.
 *
 * This route layer is only responsible for:
 *   - auth
 *   - membership gate (cron skips this — it acts on behalf of the system)
 *   - mapping the ResolveResult union to an HTTP response
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: betId } = await params;

    const sb = supabaseService();
    const { data: bet, error: betErr } = await sb
      .from("bets")
      .select("group_id")
      .eq("id", betId)
      .maybeSingle();
    if (betErr) throw new HttpError(500, `bet lookup failed: ${betErr.message}`);
    if (!bet) throw new HttpError(404, "bet not found");

    const { data: membership, error: memErr } = await sb
      .from("group_members")
      .select("user_id")
      .eq("group_id", bet.group_id)
      .eq("user_id", me.id)
      .maybeSingle();
    if (memErr) throw new HttpError(500, `member check failed: ${memErr.message}`);
    if (!membership) throw new HttpError(403, "not a member of this bet's group");

    const result = await resolveBetIfPossible(betId);

    if (result.kind === "noop") {
      return Response.json({ status: result.status }, { status: 200 });
    }
    if (result.kind === "resolving") {
      return Response.json(
        { status: "resolving", reason: result.reason },
        { status: 200 },
      );
    }
    return Response.json(
      {
        status: "settled",
        winning_outcome: result.winningOutcome,
        released: result.released,
        reason: result.reason,
        payouts: result.payouts,
        yield_credited_cents: result.yieldCredited,
      },
      { status: 200 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
