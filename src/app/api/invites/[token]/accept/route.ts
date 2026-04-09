import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { buildSafeConfig, predictGroupSafeAddress } from "@/lib/safe";

/**
 * POST /api/invites/:token/accept
 *
 * Redeem a single-use invite link to join a group.
 *
 * Constraints:
 *   - Invite must exist, not be expired, not be already used.
 *   - Group must still be `pending` (i.e. counterfactual Safe, no deposits
 *     yet). Once a group flips to `active`, membership is frozen because
 *     adding owners would change the Safe address. Post-deploy member
 *     additions require an on-chain owner-add tx — out of scope for Day 2.
 *   - Caller must not already be a member.
 *
 * On success we:
 *   1. Mark the invite consumed.
 *   2. Insert the new group_members row.
 *   3. Re-predict the Safe address with the new owner set and write it back
 *      to `groups.safe_address`. The old counterfactual address never had
 *      funds, so this is safe.
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

    // 2. Make sure the group is still in pending state.
    const { data: group, error: groupErr } = await sb
      .from("groups")
      .select("id, status")
      .eq("id", groupId)
      .single();
    if (groupErr || !group) {
      throw new HttpError(500, `group lookup failed: ${groupErr?.message}`);
    }
    if (group.status !== "pending") {
      throw new HttpError(
        409,
        "group is no longer accepting members (membership freezes on first deposit)",
      );
    }

    // 3. Ensure the caller isn't already a member.
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

    // 4. Pull the current member set so we can re-predict the Safe.
    const { data: members, error: membersErr } = await sb
      .from("group_members")
      .select("users!inner(wallet_address)")
      .eq("group_id", groupId);
    if (membersErr) throw new HttpError(500, `member fetch failed: ${membersErr.message}`);
    const currentAddresses = (members ?? [])
      .map((row: { users: { wallet_address: string } | { wallet_address: string }[] }) => {
        const u = Array.isArray(row.users) ? row.users[0] : row.users;
        return u?.wallet_address;
      })
      .filter((a): a is string => typeof a === "string");

    const memberAddresses = [
      ...currentAddresses,
      me.walletAddress,
    ] as `0x${string}`[];

    // 5. Re-predict the Safe address with the new owner set.
    const cfg = buildSafeConfig({ groupId, memberAddresses });
    const newSafeAddress = await predictGroupSafeAddress(cfg);

    // 6. Mark invite consumed (idempotent: only update if still unused).
    const { data: consumedInvite, error: consumeErr } = await sb
      .from("invite_links")
      .update({ used_at: new Date().toISOString(), used_by: me.id })
      .eq("token", token)
      .is("used_at", null)
      .select("token")
      .maybeSingle();
    if (consumeErr) throw new HttpError(500, `invite consume failed: ${consumeErr.message}`);
    if (!consumedInvite) throw new HttpError(409, "invite already used");

    // 7. Insert the membership row.
    const { error: insertErr } = await sb.from("group_members").insert({
      group_id: groupId,
      user_id: me.id,
      role: "member",
    });
    if (insertErr) {
      throw new HttpError(500, `member insert failed: ${insertErr.message}`);
    }

    // 8. Update the group's safe_address + threshold to match the new owner set.
    const { error: updateErr } = await sb
      .from("groups")
      .update({ safe_address: newSafeAddress, threshold: cfg.threshold })
      .eq("id", groupId);
    if (updateErr) {
      throw new HttpError(500, `group update failed: ${updateErr.message}`);
    }

    return Response.json(
      {
        group_id: groupId,
        safe_address: newSafeAddress,
        threshold: cfg.threshold,
      },
      { status: 200 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
