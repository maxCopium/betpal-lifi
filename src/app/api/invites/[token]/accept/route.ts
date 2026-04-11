import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";

/**
 * POST /api/invites/:token/accept
 *
 * Redeem a single-use invite link to join a group.
 *
 * Constraints:
 *   - Invite must exist, not be expired, not be already used.
 *   - Caller must not already be a member.
 *
 * On success we:
 *   1. Mark the invite consumed.
 *   2. Insert the new group_members row.
 *
 * Note: With custodial per-group wallets, the wallet address is derived from
 * the groupId and does not change when membership changes. No re-prediction
 * needed.
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { token } = await params;

    const sb = supabaseService();

    // 1. Look up the invite.
    const { data: invite, error: inviteErr } = await sb
      .from("invite_links")
      .select("token, group_id, expires_at, used_at")
      .eq("token", token)
      .maybeSingle();
    if (inviteErr) throw new HttpError(500, `invite lookup failed: ${inviteErr.message}`);
    if (!invite) throw new HttpError(404, "invite not found");
    if (invite.used_at) throw new HttpError(409, "invite already used");
    if (new Date(invite.expires_at as string).getTime() < Date.now()) {
      throw new HttpError(410, "invite expired");
    }

    const groupId = invite.group_id as string;

    // 2. Ensure the caller isn't already a member.
    const { data: existing, error: existingErr } = await sb
      .from("group_members")
      .select("user_id")
      .eq("group_id", groupId)
      .eq("user_id", me.id)
      .maybeSingle();
    if (existingErr) {
      throw new HttpError(500, `member check failed: ${existingErr.message}`);
    }
    if (existing) throw new HttpError(409, "already a member of this group");

    // 3. Mark invite consumed (idempotent: only update if still unused).
    const { data: consumedInvite, error: consumeErr } = await sb
      .from("invite_links")
      .update({ used_at: new Date().toISOString(), used_by: me.id })
      .eq("token", token)
      .is("used_at", null)
      .select("token")
      .maybeSingle();
    if (consumeErr) throw new HttpError(500, `invite consume failed: ${consumeErr.message}`);
    if (!consumedInvite) throw new HttpError(409, "invite already used");

    // 4. Insert the membership row.
    const { error: insertErr } = await sb.from("group_members").insert({
      group_id: groupId,
      user_id: me.id,
      role: "member",
    });
    if (insertErr) {
      throw new HttpError(500, `member insert failed: ${insertErr.message}`);
    }

    return Response.json(
      { group_id: groupId },
      { status: 200 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
