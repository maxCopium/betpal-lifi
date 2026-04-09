import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import {
  getGroupTotalCents,
  getUserGroupBalanceCents,
  getUserFreeBalanceCents,
} from "@/lib/ledger";

/**
 * GET /api/groups/:id/balance
 *
 * Returns the caller's projected ledger balance for the group, plus the
 * group's total. Caller must be a member.
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId } = await params;

    const sb = supabaseService();
    const { data: membership, error: memErr } = await sb
      .from("group_members")
      .select("user_id")
      .eq("group_id", groupId)
      .eq("user_id", me.id)
      .maybeSingle();
    if (memErr) throw new HttpError(500, `member check failed: ${memErr.message}`);
    if (!membership) throw new HttpError(403, "not a member of this group");

    const [userCents, freeCents, groupCents] = await Promise.all([
      getUserGroupBalanceCents(groupId, me.id),
      getUserFreeBalanceCents(groupId, me.id),
      getGroupTotalCents(groupId),
    ]);

    return Response.json({
      user_balance_cents: userCents,
      user_free_cents: freeCents,
      group_total_cents: groupCents,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
