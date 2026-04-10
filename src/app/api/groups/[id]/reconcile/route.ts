import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { getGroupTotalCents } from "@/lib/ledger";
import { getVaultBalanceCents } from "@/lib/vault";

/**
 * GET /api/groups/[id]/reconcile
 *
 * Compare the off-chain ledger sum to the on-chain Morpho vault balance for
 * the group's Safe. Returns both numbers + the drift in cents.
 *
 * Read-only — does NOT auto-correct the ledger. Drift detection is the first
 * step; auto-correction is intentionally manual until we trust the read path.
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

    const { data: group, error: groupErr } = await sb
      .from("groups")
      .select("id, safe_address, vault_address")
      .eq("id", groupId)
      .single();
    if (groupErr || !group) throw new HttpError(500, `group lookup failed: ${groupErr?.message}`);
    if (!group.safe_address) throw new HttpError(409, "group has no safe yet");

    const ledgerCents = await getGroupTotalCents(groupId);
    const onChainCents = await getVaultBalanceCents(
      group.vault_address as `0x${string}`,
      group.safe_address as `0x${string}`,
    );
    const onChainAvailable = onChainCents !== null;

    return Response.json({
      group_id: groupId,
      safe_address: group.safe_address,
      vault_address: group.vault_address,
      ledger_cents: ledgerCents,
      onchain_cents: onChainCents,
      drift_cents: onChainAvailable ? onChainCents - ledgerCents : null,
      onchain_available: onChainAvailable,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
