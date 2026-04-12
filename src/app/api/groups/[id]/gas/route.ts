import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { basePublicClient } from "@/lib/viem";

/**
 * GET /api/groups/:id/gas
 *
 * Returns the server wallet's ETH balance on Base (for gas).
 * Used by the dashboard to warn if the wallet needs funding.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId } = await params;

    const sb = supabaseService();
    const { data: membership } = await sb
      .from("group_members")
      .select("user_id")
      .eq("group_id", groupId)
      .eq("user_id", me.id)
      .maybeSingle();
    if (!membership) throw new HttpError(403, "not a member of this group");

    const { data: group } = await sb
      .from("groups")
      .select("safe_address")
      .eq("id", groupId)
      .single();
    if (!group?.safe_address) {
      throw new HttpError(409, "group wallet not initialized");
    }

    const client = basePublicClient();
    const balanceWei = await client.getBalance({
      address: group.safe_address as `0x${string}`,
    });

    // Approximate cost per tx on Base: ~0.00002 ETH
    const costPerTx = BigInt(20_000_000_000_000); // 0.00002 ETH in wei
    const txsAffordable = Number(balanceWei / costPerTx);
    const needsFunding = balanceWei < costPerTx * BigInt(5); // warn if < 5 txs

    return Response.json({
      wallet_address: group.safe_address,
      balance_wei: balanceWei.toString(),
      balance_eth: Number(balanceWei) / 1e18,
      txs_affordable: txsAffordable,
      needs_funding: needsFunding,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
