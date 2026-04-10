import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { getComposerStatus } from "@/lib/composer";
import { addBalanceEvent } from "@/lib/ledger";

/**
 * POST /api/groups/:id/withdrawals/:withdrawalId/confirm
 *
 * Phase 3 of the withdrawal flow. Polls Composer's /status for the on-chain
 * Safe transaction's hash.
 *
 * Ledger semantics:
 *   - At quote time we already debited the caller via a `withdrawal_reserve:<id>`
 *     adjustment, so the user's free balance reflects the in-flight withdrawal.
 *   - On DONE we just flip the row to `completed`. No second debit.
 *   - On FAILED we reverse the reservation via a positive `withdrawal_reverse:<id>`
 *     adjustment so the funds become spendable again.
 *
 * Both ledger writes are idempotent on their key, so polling is safe.
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; withdrawalId: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId, withdrawalId } = await params;

    const sb = supabaseService();
    const { data: tx, error: txErr } = await sb
      .from("transactions")
      .select(
        "id, group_id, user_id, status, type, tx_hash, source_chain, dest_chain, amount_cents",
      )
      .eq("id", withdrawalId)
      .maybeSingle();
    if (txErr) throw new HttpError(500, `tx lookup failed: ${txErr.message}`);
    if (!tx) throw new HttpError(404, "withdrawal not found");
    if (tx.type !== "withdrawal") throw new HttpError(400, "row is not a withdrawal");
    if (tx.group_id !== groupId)
      throw new HttpError(400, "withdrawal does not belong to this group");
    if (tx.user_id !== me.id) throw new HttpError(403, "not your withdrawal");
    if (!tx.tx_hash)
      throw new HttpError(409, "withdrawal has no tx hash yet (call PATCH first)");

    if (tx.status === "completed") {
      return Response.json({ status: "completed" }, { status: 200 });
    }
    if (tx.status === "failed" || tx.status === "reverted") {
      return Response.json({ status: tx.status }, { status: 200 });
    }

    const result = await getComposerStatus({
      txHash: tx.tx_hash as string,
      fromChain: Number(tx.source_chain),
      toChain: Number(tx.dest_chain),
    });

    if (result.status === "DONE") {
      const { error: updErr } = await sb
        .from("transactions")
        .update({
          status: "completed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", withdrawalId);
      if (updErr) throw new HttpError(500, `tx update failed: ${updErr.message}`);
      return Response.json({ status: "completed" }, { status: 200 });
    }

    if (result.status === "FAILED") {
      // Reverse the at-quote-time reservation so the user's balance unfreezes.
      // amount_cents must be present — the withdrawal route always sets it.
      const amountCents = Number(tx.amount_cents ?? 0);
      if (amountCents <= 0) {
        throw new HttpError(
          500,
          "withdrawal has no amount_cents — cannot reverse reservation (manual reconciliation needed)",
        );
      }
      await addBalanceEvent({
        groupId,
        userId: me.id,
        deltaCents: amountCents,
        reason: "adjustment",
        idempotencyKey: `withdrawal_reverse:${withdrawalId}`,
      });
      const { error: updErr } = await sb
        .from("transactions")
        .update({
          status: "failed",
          error_message: result.substatus ?? "composer reported FAILED",
          updated_at: new Date().toISOString(),
        })
        .eq("id", withdrawalId);
      if (updErr) throw new HttpError(500, `tx update failed: ${updErr.message}`);
      return Response.json({ status: "failed" }, { status: 200 });
    }

    return Response.json(
      {
        status: "executing",
        composerStatus: result.status,
        substatus: result.substatus,
      },
      { status: 200 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
