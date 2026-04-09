import "server-only";
import { randomBytes } from "node:crypto";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";

/**
 * POST /api/groups/:id/invites
 *
 * Mint a new invite link for a group. Caller must be a member.
 *
 * Token format: 24-byte url-safe base64 (~32 chars). High entropy, opaque, no
 * collision risk for the foreseeable future. We store the raw token because
 * (a) it's already random and (b) we want to be able to look it up directly
 * via the URL the inviter shares.
 *
 * Expiry: 7 days. Single-use; `used_at` + `used_by` are filled when redeemed.
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function makeToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId } = await params;

    const sb = supabaseService();
    const { data: membership, error: memberErr } = await sb
      .from("group_members")
      .select("user_id")
      .eq("group_id", groupId)
      .eq("user_id", me.id)
      .maybeSingle();
    if (memberErr) throw new HttpError(500, `membership check failed: ${memberErr.message}`);
    if (!membership) throw new HttpError(403, "not a member of this group");

    const token = makeToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

    const { error: insertErr } = await sb.from("invite_links").insert({
      token,
      group_id: groupId,
      inviter_id: me.id,
      expires_at: expiresAt,
    });
    if (insertErr) throw new HttpError(500, `invite insert failed: ${insertErr.message}`);

    return Response.json({ token, expires_at: expiresAt }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
