import "server-only";
import { z } from "zod";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { resolveBetIfPossible } from "@/lib/resolveBet";

/**
 * Force resolve — unanimous agreement to settle a bet with a chosen outcome.
 *
 * Flow:
 *   1. Any staker proposes: POST { outcome: "Yes" }
 *   2. Proposer is auto-counted as a vote.
 *   3. Other stakers accept: POST { accept: true }
 *   4. Any staker can reject: DELETE (clears proposal + all votes)
 *   5. When ALL stakers have voted → sets mock_resolved_outcome, triggers resolution.
 *
 * GET returns current proposal status.
 */

const ProposeBody = z.object({
  outcome: z.string().min(1),
});

const VoteBody = z.object({
  accept: z.literal(true),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: betId } = await params;
    const json = await request.json().catch(() => {
      throw new HttpError(400, "invalid json body");
    });

    const sb = supabaseService();

    // Fetch bet.
    const { data: bet, error: betErr } = await sb
      .from("bets")
      .select("id, options, status, force_resolve_outcome, force_resolve_proposed_by")
      .eq("id", betId)
      .maybeSingle();
    if (betErr) throw new HttpError(500, `bet lookup failed: ${betErr.message}`);
    if (!bet) throw new HttpError(404, "bet not found");
    if (bet.status === "settled" || bet.status === "voided") {
      throw new HttpError(409, `bet already ${bet.status}`);
    }

    // Verify caller has a stake.
    const { data: stake } = await sb
      .from("stakes")
      .select("id")
      .eq("bet_id", betId)
      .eq("user_id", me.id)
      .maybeSingle();
    if (!stake) throw new HttpError(403, "you have no stake on this bet");

    const hasProposal = !!(bet.force_resolve_outcome as string | null);

    if (!hasProposal) {
      // ── New proposal ──
      const body = ProposeBody.parse(json);
      const options = Array.isArray(bet.options) ? (bet.options as string[]) : [];
      if (options.length > 0 && !options.includes(body.outcome)) {
        throw new HttpError(400, `invalid outcome — valid: ${options.join(", ")}`);
      }

      // Store proposal.
      await sb
        .from("bets")
        .update({
          force_resolve_outcome: body.outcome,
          force_resolve_proposed_by: me.id,
        })
        .eq("id", betId);

      // Auto-vote for proposer.
      await sb
        .from("force_resolve_votes")
        .insert({ bet_id: betId, user_id: me.id })
        .select("bet_id"); // ignore duplicate

      return await checkUnanimousAndRespond(sb, betId, me.id);
    } else {
      // ── Vote on existing proposal ──
      VoteBody.parse(json);

      await sb
        .from("force_resolve_votes")
        .insert({ bet_id: betId, user_id: me.id })
        .select("bet_id");

      return await checkUnanimousAndRespond(sb, betId, me.id);
    }
  } catch (e) {
    return errorResponse(e);
  }
}

async function checkUnanimousAndRespond(
  sb: ReturnType<typeof supabaseService>,
  betId: string,
  _userId: string,
): Promise<Response> {
  const { data: allStakers } = await sb
    .from("stakes")
    .select("user_id")
    .eq("bet_id", betId);
  const { data: allVotes } = await sb
    .from("force_resolve_votes")
    .select("user_id")
    .eq("bet_id", betId);
  const { data: bet } = await sb
    .from("bets")
    .select("force_resolve_outcome")
    .eq("id", betId)
    .single();

  const stakerIds = new Set((allStakers ?? []).map((s) => s.user_id as string));
  const voteIds = new Set((allVotes ?? []).map((v) => v.user_id as string));
  const allVoted = [...stakerIds].every((id) => voteIds.has(id));

  if (allVoted && stakerIds.size > 0) {
    // Unanimous — set mock_resolved_outcome and trigger resolution.
    const outcome = bet?.force_resolve_outcome as string;
    await sb
      .from("bets")
      .update({ mock_resolved_outcome: outcome })
      .eq("id", betId);

    const result = await resolveBetIfPossible(betId);

    return Response.json({
      status: "resolved",
      outcome,
      votes: voteIds.size,
      total: stakerIds.size,
      result,
    });
  }

  return Response.json({
    status: "pending",
    outcome: bet?.force_resolve_outcome,
    votes: voteIds.size,
    total: stakerIds.size,
    voterIds: [...voteIds],
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireUser(request);
    const { id: betId } = await params;
    const sb = supabaseService();

    const { data: bet } = await sb
      .from("bets")
      .select("force_resolve_outcome, force_resolve_proposed_by")
      .eq("id", betId)
      .single();

    if (!bet?.force_resolve_outcome) {
      return Response.json({ pending: false });
    }

    const { data: allStakers } = await sb
      .from("stakes")
      .select("user_id")
      .eq("bet_id", betId);
    const { data: allVotes } = await sb
      .from("force_resolve_votes")
      .select("user_id")
      .eq("bet_id", betId);

    // Get proposer name.
    let proposerName: string | null = null;
    if (bet.force_resolve_proposed_by) {
      const { data: user } = await sb
        .from("users")
        .select("display_name, wallet_address")
        .eq("id", bet.force_resolve_proposed_by)
        .single();
      proposerName = (user?.display_name as string) ?? (user?.wallet_address as string) ?? null;
    }

    return Response.json({
      pending: true,
      outcome: bet.force_resolve_outcome,
      proposed_by: bet.force_resolve_proposed_by,
      proposed_by_name: proposerName,
      votes: (allVotes ?? []).length,
      total: (allStakers ?? []).length,
      voterIds: (allVotes ?? []).map((v) => v.user_id),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * DELETE — reject / cancel a force resolve proposal.
 * Clears the proposal and all votes.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: betId } = await params;
    const sb = supabaseService();

    // Verify caller has a stake.
    const { data: stake } = await sb
      .from("stakes")
      .select("id")
      .eq("bet_id", betId)
      .eq("user_id", me.id)
      .maybeSingle();
    if (!stake) throw new HttpError(403, "you have no stake on this bet");

    // Clear proposal.
    await sb
      .from("bets")
      .update({
        force_resolve_outcome: null,
        force_resolve_proposed_by: null,
      })
      .eq("id", betId);

    // Clear all votes.
    await sb
      .from("force_resolve_votes")
      .delete()
      .eq("bet_id", betId);

    return Response.json({ status: "rejected" });
  } catch (e) {
    return errorResponse(e);
  }
}
