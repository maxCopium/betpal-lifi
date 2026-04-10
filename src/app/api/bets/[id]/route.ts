import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";

/**
 * GET /api/bets/[id]
 *
 * Bet detail with current stakes. Caller must be a member of the group that
 * owns the bet.
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */
export async function GET(
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
        "id, group_id, creator_id, title, options, polymarket_market_id, polymarket_url, join_deadline, max_resolution_date, status, resolution_outcome, settled_at, created_at",
      )
      .eq("id", betId)
      .maybeSingle();
    if (betErr) throw new HttpError(500, `bet lookup failed: ${betErr.message}`);
    if (!bet) throw new HttpError(404, "bet not found");

    // Membership gate.
    const { data: membership, error: memErr } = await sb
      .from("group_members")
      .select("user_id")
      .eq("group_id", bet.group_id)
      .eq("user_id", me.id)
      .maybeSingle();
    if (memErr) throw new HttpError(500, `member check failed: ${memErr.message}`);
    if (!membership) throw new HttpError(403, "not a member of this bet's group");

    const { data: stakeRows, error: stakeErr } = await sb
      .from("stakes")
      .select("id, user_id, outcome_chosen, amount_cents, created_at")
      .eq("bet_id", betId);
    if (stakeErr) throw new HttpError(500, `stake list failed: ${stakeErr.message}`);

    // Decorate stakes with the staker's display label so the UI can show
    // "alice · 5.00 USD" rather than a raw uuid. We resolve in one batched
    // query to avoid N+1 fetches.
    const userIds = Array.from(new Set((stakeRows ?? []).map((s) => s.user_id as string)));
    const labels = new Map<string, string>();
    if (userIds.length > 0) {
      const { data: userRows, error: userErr } = await sb
        .from("users")
        .select("id, display_name, ens_name, basename, wallet_address")
        .in("id", userIds);
      if (userErr) throw new HttpError(500, `user lookup failed: ${userErr.message}`);
      for (const u of userRows ?? []) {
        const wallet = (u.wallet_address as string | null) ?? "";
        const short = wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "user";
        const label =
          (u.display_name as string | null) ??
          (u.ens_name as string | null) ??
          (u.basename as string | null) ??
          short;
        labels.set(u.id as string, label);
      }
    }
    const stakes = (stakeRows ?? []).map((s) => ({
      ...s,
      user_label: labels.get(s.user_id as string) ?? "user",
    }));

    const myStake = stakes.find((s) => s.user_id === me.id) ?? null;

    return Response.json({ bet, stakes, my_stake: myStake });
  } catch (e) {
    return errorResponse(e);
  }
}
