import "server-only";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { addBalanceEvent, getUserFreeBalanceCents } from "@/lib/ledger";
import { redeemFromVault, PartialRedeemError } from "@/lib/vault";
import { BASE_CHAIN_ID } from "@/lib/constants";

/**
 * POST /api/groups/[id]/withdrawals
 *
 * Withdraw a user's free balance from the group's Morpho vault to their
 * personal wallet. The server signs and broadcasts vault.redeem() + USDC
 * transfer using the group's derived custodial wallet.
 *
 * Flow:
 *   1. Auth + membership gate.
 *   2. Verify free balance ≥ requested amount.
 *   3. Reserve funds in ledger (negative adjustment).
 *   4. Redeem from vault + transfer USDC to user's wallet.
 *   5. On success: mark transaction completed.
 *      On failure: reverse the ledger reservation.
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */

const Body = z.object({
  amountCents: z.number().int().positive(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId } = await params;
    const json = await request.json().catch(() => {
      throw new HttpError(400, "invalid json body");
    });
    const body = Body.parse(json);

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

    // Fetch group wallet + vault details for Privy signing.
    const { data: group, error: grpErr } = await sb
      .from("groups")
      .select("privy_wallet_id, wallet_address, vault_address")
      .eq("id", groupId)
      .single();
    if (grpErr || !group) throw new HttpError(500, `group lookup failed: ${grpErr?.message}`);
    if (!group.privy_wallet_id || !group.wallet_address || !group.vault_address) {
      throw new HttpError(409, "group wallet or vault not initialized yet");
    }

    // Free-balance check.
    const free = await getUserFreeBalanceCents(groupId, me.id);
    if (free < body.amountCents) {
      throw new HttpError(
        402,
        `insufficient free balance: have ${free} cents, need ${body.amountCents}`,
      );
    }

    const withdrawalId = randomUUID();

    // Reserve funds immediately so concurrent withdrawals can't double-spend.
    // Uses withdrawal_reserve which goes through overdraw guard.
    await addBalanceEvent({
      groupId,
      userId: me.id,
      deltaCents: -body.amountCents,
      reason: "withdrawal_reserve",
      idempotencyKey: `withdrawal_reserve:${withdrawalId}`,
    });

    // Insert transaction record.
    const { error: txErr } = await sb.from("transactions").insert({
      id: withdrawalId,
      group_id: groupId,
      user_id: me.id,
      type: "withdrawal",
      amount_cents: body.amountCents,
      source_chain: BASE_CHAIN_ID,
      source_token: "vault",
      dest_chain: BASE_CHAIN_ID,
      dest_token: "USDC",
      status: "executing",
      idempotency_key: `withdrawal:${withdrawalId}`,
    });
    if (txErr) throw new HttpError(500, `tx insert failed: ${txErr.message}`);

    // Execute on-chain: redeem from vault + transfer USDC to user.
    try {
      const { redeemTxHash, transferTxHash } = await redeemFromVault(
        group.privy_wallet_id as string,
        group.vault_address as `0x${string}`,
        group.wallet_address as `0x${string}`,
        body.amountCents,
        me.walletAddress as `0x${string}`,
      );

      // Mark completed.
      await sb
        .from("transactions")
        .update({
          status: "completed",
          tx_hash: transferTxHash,
          completed_at: new Date().toISOString(),
        })
        .eq("id", withdrawalId);

      return Response.json(
        {
          withdrawalId,
          redeemTxHash,
          transferTxHash,
          amountCents: body.amountCents,
          status: "completed",
        },
        { status: 201 },
      );
    } catch (chainErr) {
      if (chainErr instanceof PartialRedeemError) {
        // Vault shares redeemed but USDC transfer failed — do NOT reverse
        // the ledger reservation because the USDC is out of the vault.
        // It's sitting in the group wallet; manual transfer can recover it.
        await sb
          .from("transactions")
          .update({
            status: "partial",
            tx_hash: chainErr.redeemTxHash,
            error_message: chainErr.message,
          })
          .eq("id", withdrawalId);

        throw new HttpError(
          502,
          `vault redeemed but transfer failed — USDC is in group wallet. ${chainErr.message}`,
        );
      }

      // Full failure (redeem never happened): reverse the ledger reservation.
      await addBalanceEvent({
        groupId,
        userId: me.id,
        deltaCents: body.amountCents,
        reason: "withdrawal_reverse",
        idempotencyKey: `withdrawal_reverse:${withdrawalId}`,
      });
      await sb
        .from("transactions")
        .update({ status: "failed" })
        .eq("id", withdrawalId);

      throw new HttpError(
        502,
        `on-chain withdrawal failed: ${(chainErr as Error).message}`,
      );
    }
  } catch (e) {
    return errorResponse(e);
  }
}
