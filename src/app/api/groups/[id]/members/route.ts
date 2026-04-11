import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";

/**
 * GET /api/groups/:id/members
 *
 * Returns the list of members for a group. Caller must be a member.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId } = await params;

    const sb = supabaseService();

    // Verify caller is a member
    const { data: membership, error: memErr } = await sb
      .from("group_members")
      .select("user_id")
      .eq("group_id", groupId)
      .eq("user_id", me.id)
      .maybeSingle();
    if (memErr) throw new HttpError(500, `member check failed: ${memErr.message}`);
    if (!membership) throw new HttpError(403, "not a member of this group");

    // Fetch all members with user info
    const { data: members, error: fetchErr } = await sb
      .from("group_members")
      .select("role, joined_at, user_id, users(display_name, wallet_address, basename, ens_name)")
      .eq("group_id", groupId)
      .order("joined_at", { ascending: true });

    if (fetchErr) throw new HttpError(500, `fetch members failed: ${fetchErr.message}`);

    const result = (members ?? []).map((m) => {
      const u = m.users as unknown as {
        display_name: string | null;
        wallet_address: string;
        basename: string | null;
        ens_name: string | null;
      } | null;
      return {
        user_id: m.user_id,
        role: m.role,
        joined_at: m.joined_at,
        display_name: u?.display_name ?? u?.basename ?? u?.ens_name ?? null,
        wallet_address: u?.wallet_address ?? null,
      };
    });

    return Response.json({ members: result });
  } catch (e) {
    return errorResponse(e);
  }
}
