import "server-only";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { getComposerQuote } from "@/lib/composer";
import { addBalanceEvent, getUserFreeBalanceCents } from "@/lib/ledger";

/**
 * POST /api/groups/[id]/withdrawals
 *
 * Request a Composer route to withdraw a user's free balance from the group's
 * Morpho vault token (on Base) to a destination chain/token of their choice,
 * delivered to their personal wallet.
 *
 * This demonstrates LI.FI Composer's "vault token as fromToken" capability —
 * a single quote that unwinds the vault position and bridges in one route.
 *
 * Behaviour:
 *   1. Auth + membership gate.
 *   2. Verify free balance ≥ requested amount.
 *   3. Fetch a Composer quote (fromToken = vault address on Base).
 *   4. Insert a `transactions` row in `pending` with the quote id.
 *   5. Decrement the caller's ledger balance immediately via a negative
 *      `adjustment` event keyed on the deposit-id, so the UI reflects the
 *      pending withdrawal. If the on-chain Safe tx never executes, the
 *      reconciliation worker will reverse the adjustment.
 *
 * Note: actually moving funds out of the Safe still requires threshold
 * signatures on a Safe transaction. The frontend shows the user the Composer
 * route + a Safe Web App deeplink so they can submit the tx for member
 * approval. The PATCH/confirm pattern from the deposit flow applies once a
 * tx hash is reported.
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */

const Body = z.object({
  toChain: z.number().int().positive(),
  toToken: z.string().min(1),
  amountCents: z.number().int().positive(),
  /**
   * Vault-token base units to withdraw. Caller computes this on the client
   * (cents → vault-share units) because the precise share→USDC ratio depends
   * on the vault's current price. We trust the client value here and
   * reconcile against on-chain post-execution.
   */
  fromAmount: z.string().regex(/^\d+$/, "fromAmount must be base-units"),
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

    // Membership.
    const { data: membership, error: memErr } = await sb
      .from("group_members")
      .select("user_id")
      .eq("group_id", groupId)
      .eq("user_id", me.id)
      .maybeSingle();
    if (memErr) throw new HttpError(500, `member check failed: ${memErr.message}`);
    if (!membership) throw new HttpError(403, "not a member of this group");

    // Group + safe + vault.
    const { data: group, error: groupErr } = await sb
      .from("groups")
      .select("id, safe_address, vault_address, vault_chain_id")
      .eq("id", groupId)
      .single();
    if (groupErr || !group) {
      throw new HttpError(500, `group lookup failed: ${groupErr?.message}`);
    }
    if (!group.safe_address) throw new HttpError(409, "group has no safe yet");

    // Free-balance check (locked stakes are excluded by getUserFreeBalanceCents).
    const free = await getUserFreeBalanceCents(groupId, me.id);
    if (free < body.amountCents) {
      throw new HttpError(
        402,
        `insufficient free balance: have ${free} cents, need ${body.amountCents}`,
      );
    }

    // Quote: vault token → destination, sent to caller's wallet.
    const quote = await getComposerQuote({
      fromChain: Number(group.vault_chain_id),
      toChain: body.toChain,
      fromToken: group.vault_address as string,
      toToken: body.toToken,
      fromAmount: body.fromAmount,
      // From-address is the Safe (owner of the vault position).
      fromAddress: group.safe_address as string,
      // Recipient is the caller's wallet on the destination chain.
      toAddress: me.walletAddress,
    });

    const withdrawalId = randomUUID();
    const idempotencyKey = `withdrawal_quote:${quote.id}:${me.id}`;
    const { data: txRow, error: txErr } = await sb
      .from("transactions")
      .insert({
        id: withdrawalId,
        group_id: groupId,
        user_id: me.id,
        type: "withdrawal",
        amount_cents: body.amountCents,
        source_chain: Number(group.vault_chain_id),
        source_token: group.vault_address as string,
        dest_chain: body.toChain,
        dest_token: body.toToken,
        composer_route_id: quote.id,
        status: "pending",
        idempotency_key: idempotencyKey,
      })
      .select("id")
      .single();
    if (txErr) {
      if (txErr.code === "23505") {
        const { data: existing } = await sb
          .from("transactions")
          .select("id")
          .eq("idempotency_key", idempotencyKey)
          .single();
        return Response.json(
          { withdrawalId: existing?.id, quote },
          { status: 200 },
        );
      }
      throw new HttpError(500, `tx insert failed: ${txErr.message}`);
    }

    // Reserve the funds in the ledger immediately so concurrent withdrawals
    // can't double-spend the same balance. Reconciliation will reverse this
    // adjustment if the on-chain tx never executes.
    await addBalanceEvent({
      groupId,
      userId: me.id,
      deltaCents: -body.amountCents,
      reason: "adjustment",
      idempotencyKey: `withdrawal_reserve:${withdrawalId}`,
    });

    return Response.json({ withdrawalId: txRow.id, quote }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
