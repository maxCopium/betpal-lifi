import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { redeemFromVault, PartialRedeemError } from "@/lib/vault";

/**
 * POST /api/groups/[id]/withdrawals/[withdrawalId]/retry
 *
 * Retry a `partial` withdrawal: vault.redeem() previously succeeded but
 * USDC.transfer() to the user reverted, leaving the USDC stranded in the
 * group wallet. The ledger debit is still in place — the user is "owed"
 * that USDC by withdrawal id.
 *
 * `redeemFromVault` checks USDC balance first and short-circuits to a
 * pure transfer when the group wallet already holds enough, so calling
 * it again here just transfers the stranded dust. No new shares burn.
 */

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; withdrawalId: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId, withdrawalId } = await params;
    const sb = supabaseService();

    // Membership check.
    const { data: membership, error: memErr } = await sb
      .from("group_members")
      .select("user_id")
      .eq("group_id", groupId)
      .eq("user_id", me.id)
      .maybeSingle();
    if (memErr) throw new HttpError(500, `member check failed: ${memErr.message}`);
    if (!membership) throw new HttpError(403, "not a member of this group");

    // Load the partial withdrawal.
    const { data: tx, error: txErr } = await sb
      .from("transactions")
      .select("id, group_id, user_id, type, amount_cents, status")
      .eq("id", withdrawalId)
      .single();
    if (txErr || !tx) throw new HttpError(404, "withdrawal not found");
    if (tx.group_id !== groupId) throw new HttpError(403, "withdrawal does not belong to this group");
    if (tx.user_id !== me.id) throw new HttpError(403, "not your withdrawal");
    if (tx.type !== "withdrawal") throw new HttpError(400, "not a withdrawal transaction");
    if (tx.status !== "partial") {
      throw new HttpError(409, `cannot retry — withdrawal status is "${tx.status}"`);
    }
    if (!tx.amount_cents || tx.amount_cents <= 0) {
      throw new HttpError(500, "withdrawal has no amount");
    }

    // Group wallet + vault details.
    const { data: group, error: grpErr } = await sb
      .from("groups")
      .select("privy_wallet_id, wallet_address, vault_address")
      .eq("id", groupId)
      .single();
    if (grpErr || !group) throw new HttpError(500, `group lookup failed: ${grpErr?.message}`);
    if (!group.privy_wallet_id || !group.wallet_address || !group.vault_address) {
      throw new HttpError(409, "group wallet or vault not initialized yet");
    }

    // Mark executing.
    await sb
      .from("transactions")
      .update({ status: "executing" })
      .eq("id", withdrawalId);

    try {
      const { transferTxHash } = await redeemFromVault(
        group.privy_wallet_id as string,
        group.vault_address as `0x${string}`,
        group.wallet_address as `0x${string}`,
        tx.amount_cents as number,
        me.walletAddress as `0x${string}`,
      );

      await sb
        .from("transactions")
        .update({
          status: "completed",
          tx_hash: transferTxHash,
          completed_at: new Date().toISOString(),
          error_message: null,
        })
        .eq("id", withdrawalId);

      return Response.json(
        { withdrawalId, transferTxHash, status: "completed" },
        { status: 200 },
      );
    } catch (chainErr) {
      // Roll status back to partial so the user can retry again.
      const errMsg = chainErr instanceof PartialRedeemError
        ? chainErr.message
        : (chainErr as Error).message;
      await sb
        .from("transactions")
        .update({ status: "partial", error_message: errMsg })
        .eq("id", withdrawalId);

      throw new HttpError(502, `retry failed: ${errMsg}`);
    }
  } catch (e) {
    return errorResponse(e);
  }
}
