import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { computePayouts, type Stake } from "@/lib/payouts";
import { addBalanceEvent } from "@/lib/ledger";

/**
 * POST /api/bets/[id]/cancel-vote
 *
 * Vote to cancel a bet. When ALL stakers have voted, the bet is voided:
 * principal refunded + accrued yield distributed pro-rata.
 *
 * GET /api/bets/[id]/cancel-vote
 *
 * Returns current cancel vote status.
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

    // Verify user has a stake on this bet.
    const { data: stake, error: stakeErr } = await sb
      .from("stakes")
      .select("id")
      .eq("bet_id", betId)
      .eq("user_id", me.id)
      .maybeSingle();
    if (stakeErr) throw new HttpError(500, `stake check failed: ${stakeErr.message}`);
    if (!stake) throw new HttpError(403, "you have no stake on this bet");

    // Verify bet is in a cancellable state.
    const { data: bet, error: betErr } = await sb
      .from("bets")
      .select("id, group_id, status")
      .eq("id", betId)
      .single();
    if (betErr || !bet) throw new HttpError(500, `bet lookup failed: ${betErr?.message}`);
    if (bet.status === "settled" || bet.status === "voided") {
      throw new HttpError(409, `bet already ${bet.status}`);
    }

    // Insert cancel vote (idempotent — primary key conflict is fine).
    const { error: voteErr } = await sb
      .from("cancel_votes")
      .insert({ bet_id: betId, user_id: me.id })
      .select("bet_id");
    if (voteErr && voteErr.code !== "23505") {
      throw new HttpError(500, `vote insert failed: ${voteErr.message}`);
    }

    // Check if all stakers have voted.
    const { data: allStakers } = await sb
      .from("stakes")
      .select("user_id")
      .eq("bet_id", betId);
    const { data: allVotes } = await sb
      .from("cancel_votes")
      .select("user_id")
      .eq("bet_id", betId);

    const stakerIds = new Set((allStakers ?? []).map((s) => s.user_id));
    const voteIds = new Set((allVotes ?? []).map((v) => v.user_id));
    const allVoted = [...stakerIds].every((id) => voteIds.has(id as string));

    if (allVoted && stakerIds.size > 0) {
      // Unanimous — void the bet.
      const groupId = bet.group_id as string;

      // Fetch stakes for payout calculation.
      const { data: stakeRows } = await sb
        .from("stakes")
        .select("user_id, outcome_chosen, amount_cents")
        .eq("bet_id", betId);
      const stakes: Stake[] = (stakeRows ?? []).map((r) => ({
        userId: r.user_id as string,
        outcomeChosen: r.outcome_chosen as string,
        amountCents: Number(r.amount_cents),
      }));
      const totalPoolCents = stakes.reduce((a, s) => a + s.amountCents, 0);

      // Compute refund payouts (winningOutcome = null → void).
      const result = computePayouts({
        stakes,
        winningOutcome: null,
        totalPoolCents,
      });

      // Write refund ledger events.
      for (const p of result.payouts) {
        if (p.amountCents <= 0) continue;
        // First: reverse the stake lock.
        await addBalanceEvent({
          groupId,
          userId: p.userId,
          deltaCents: p.amountCents,
          reason: "stake_refund",
          betId,
          idempotencyKey: `cancel_refund:${betId}:${p.userId}`,
        });
      }

      // Void the bet — status guard prevents voiding already-settled bets.
      await sb
        .from("bets")
        .update({
          status: "voided",
          resolution_outcome: null,
          settled_at: new Date().toISOString(),
        })
        .eq("id", betId)
        .in("status", ["open", "locked", "resolving"]);

      return Response.json({
        voted: true,
        unanimous: true,
        voided: true,
        votes: voteIds.size,
        total: stakerIds.size,
      });
    }

    return Response.json({
      voted: true,
      unanimous: false,
      votes: voteIds.size,
      total: stakerIds.size,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: betId } = await params;
    const sb = supabaseService();

    // Membership gate via bet's group.
    const { data: bet } = await sb
      .from("bets")
      .select("group_id")
      .eq("id", betId)
      .maybeSingle();
    if (!bet) throw new HttpError(404, "bet not found");
    const { data: membership } = await sb
      .from("group_members")
      .select("user_id")
      .eq("group_id", bet.group_id)
      .eq("user_id", me.id)
      .maybeSingle();
    if (!membership) throw new HttpError(403, "not a member of this bet's group");

    const { data: allStakers } = await sb
      .from("stakes")
      .select("user_id")
      .eq("bet_id", betId);
    const { data: allVotes } = await sb
      .from("cancel_votes")
      .select("user_id")
      .eq("bet_id", betId);

    return Response.json({
      votes: (allVotes ?? []).length,
      total: (allStakers ?? []).length,
      voterIds: (allVotes ?? []).map((v) => v.user_id),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
