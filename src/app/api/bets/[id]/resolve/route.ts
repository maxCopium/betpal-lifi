import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { addBalanceEvent } from "@/lib/ledger";
import { computePayouts, type Stake } from "@/lib/payouts";
import { getMarket, isMarketSettleable } from "@/lib/polymarket";

/**
 * POST /api/bets/[id]/resolve
 *
 * Try to settle a bet.
 *
 * Preconditions:
 *   - Caller must be a member of the bet's group.
 *   - Bet status must be `open` or `locked` (in-progress) — never `settled`
 *     or `voided`.
 *   - Join deadline must have passed (otherwise the pool isn't final).
 *
 * Process:
 *   1. Fetch the bet + stakes (sources of truth).
 *   2. Pull the Polymarket market and ask `isMarketSettleable`. If not yet
 *      settleable, flip status → `resolving` (so the UI knows we tried) and
 *      return.
 *   3. If settleable, compute payouts via `computePayouts` (pari-mutuel,
 *      integer cents, exact). The total pool equals the sum of locked
 *      stakes (no yield credit yet — that lands when the resolver writes a
 *      `yield_credit` event in a follow-up step).
 *   4. Write a `payout` balance event per recipient (idempotent on
 *      `payout:<betId>:<userId>`). Refund / void cases just return the
 *      principal back as a positive ledger delta.
 *   5. Flip the bet to `settled` with `resolution_outcome` set.
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
      .select(
        "id, group_id, polymarket_market_id, status, join_deadline, options",
      )
      .eq("id", betId)
      .maybeSingle();
    if (betErr) throw new HttpError(500, `bet lookup failed: ${betErr.message}`);
    if (!bet) throw new HttpError(404, "bet not found");
    if (bet.status === "settled" || bet.status === "voided") {
      return Response.json({ status: bet.status }, { status: 200 });
    }
    if (new Date(bet.join_deadline as string).getTime() > Date.now()) {
      throw new HttpError(409, "join deadline has not passed");
    }

    // Membership gate.
    const { data: membership, error: memErr } = await sb
      .from("group_members")
      .select("user_id")
      .eq("group_id", bet.group_id)
      .eq("user_id", me.id)
      .maybeSingle();
    if (memErr) throw new HttpError(500, `member check failed: ${memErr.message}`);
    if (!membership) throw new HttpError(403, "not a member of this bet's group");

    // Pull stakes — these are the locked principals.
    const { data: stakeRows, error: stakeErr } = await sb
      .from("stakes")
      .select("user_id, outcome_chosen, amount_cents")
      .eq("bet_id", betId);
    if (stakeErr) throw new HttpError(500, `stake fetch failed: ${stakeErr.message}`);
    const stakes: Stake[] = (stakeRows ?? []).map((r) => ({
      userId: r.user_id as string,
      outcomeChosen: r.outcome_chosen as string,
      amountCents: Number(r.amount_cents),
    }));
    const totalPoolCents = stakes.reduce((a, s) => a + s.amountCents, 0);

    // Polymarket settleability check.
    const market = await getMarket(bet.polymarket_market_id as string);
    const settle = isMarketSettleable(market);

    if (!settle.settleable) {
      // Mark `resolving` so the dashboard shows we're tracking it. The next
      // resolve attempt re-checks Polymarket; this is intentionally manual for
      // now (a Day 4 cron will poll automatically).
      await sb.from("bets").update({ status: "resolving" }).eq("id", betId);
      return Response.json(
        { status: "resolving", reason: settle.reason ?? "not settleable yet" },
        { status: 200 },
      );
    }

    // Compute payouts. Refund cases (no_winners / single_outcome / single_staker)
    // are handled inside computePayouts.
    const result = computePayouts({
      stakes,
      winningOutcome: settle.winningOutcome ?? null,
      totalPoolCents,
    });

    // Credit each recipient's ledger. The stake_lock event already debited the
    // principal at lock-time; the payout credit covers their full take (which
    // for refunds is just their principal back).
    for (const p of result.payouts) {
      if (p.amountCents <= 0) continue;
      await addBalanceEvent({
        groupId: bet.group_id as string,
        userId: p.userId,
        deltaCents: p.amountCents,
        reason: "payout",
        betId,
        idempotencyKey: `payout:${betId}:${p.userId}`,
      });
    }

    // Flip bet to settled.
    const { error: updErr } = await sb
      .from("bets")
      .update({
        status: "settled",
        resolution_outcome: settle.winningOutcome ?? null,
        settled_at: new Date().toISOString(),
        resolution_evidence: { source: "polymarket", market_id: bet.polymarket_market_id },
      })
      .eq("id", betId);
    if (updErr) throw new HttpError(500, `bet update failed: ${updErr.message}`);

    return Response.json(
      {
        status: "settled",
        winning_outcome: settle.winningOutcome ?? null,
        refunded: result.refunded,
        reason: result.reason,
        payouts: result.payouts,
      },
      { status: 200 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
