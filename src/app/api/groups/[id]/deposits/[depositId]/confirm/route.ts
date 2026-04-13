import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { getComposerStatus } from "@/lib/composer";
import { addBalanceEvent } from "@/lib/ledger";

/**
 * POST /api/groups/:id/deposits/:depositId/confirm
 *
 * Phase 3 of the deposit flow. Polls LI.FI Composer's /status endpoint for
 * the deposit's tx hash. Behavior depends on the returned status:
 *
 *   - PENDING: nothing to do, return current state.
 *   - DONE: write a `balance_events` deposit credit (idempotent on tx hash),
 *     flip the transactions row to `completed`, and flip the group from
 *     `pending` → `active` (membership freezes here, see invite accept route).
 *   - FAILED: flip the row to `failed` with the error message.
 *
 * Idempotency: the balance event is keyed on `deposit:<txHash>`. Calling this
 * endpoint repeatedly is safe.
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; depositId: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId, depositId } = await params;

    const sb = supabaseService();
    const { data: tx, error: txErr } = await sb
      .from("transactions")
      .select(
        "id, group_id, user_id, status, tx_hash, source_chain, dest_chain, amount_cents, intended_bet_id, intended_outcome",
      )
      .eq("id", depositId)
      .maybeSingle();
    if (txErr) throw new HttpError(500, `tx lookup failed: ${txErr.message}`);
    if (!tx) throw new HttpError(404, "deposit not found");
    if (tx.group_id !== groupId) throw new HttpError(400, "deposit does not belong to this group");
    if (tx.user_id !== me.id) throw new HttpError(403, "not your deposit");
    if (!tx.tx_hash) throw new HttpError(409, "deposit has no tx hash yet (call PATCH first)");

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
      // amount_cents is derived from the Composer quote's toAmountMin at quote
      // time — it's oracle-sourced, not user-supplied. If it's somehow missing,
      // fail loudly rather than crediting 0.
      const amountCents = Number(tx.amount_cents ?? 0);
      if (amountCents <= 0) {
        throw new HttpError(
          500,
          "deposit has no amount_cents — cannot credit ledger (manual reconciliation needed)",
        );
      }

      await addBalanceEvent({
        groupId,
        userId: me.id,
        deltaCents: amountCents,
        reason: "deposit",
        txHash: tx.tx_hash as string,
        idempotencyKey: `deposit:${tx.tx_hash}`,
      });

      // No server-side vault deposit needed — Composer deposits directly into
      // the Morpho vault atomically (toToken = vault address).

      const { error: updErr } = await sb
        .from("transactions")
        .update({
          status: "completed",
          actual_amount_cents: amountCents,
          updated_at: new Date().toISOString(),
        })
        .eq("id", depositId);
      if (updErr) throw new HttpError(500, `tx update failed: ${updErr.message}`);

      // Promote group to active on first successful deposit.
      await sb
        .from("groups")
        .update({ status: "active" })
        .eq("id", groupId)
        .eq("status", "pending");

      // Auto-stake if this deposit was targeted at a bet.
      let stakeStatus: string | null = null;
      if (tx.intended_bet_id && tx.intended_outcome) {
        try {
          // Re-validate: bet may have closed or deadline passed during bridge.
          const { data: bet } = await sb
            .from("bets")
            .select("status, join_deadline, options, stake_amount_cents")
            .eq("id", tx.intended_bet_id)
            .single();

          if (!bet || bet.status !== "open") {
            stakeStatus = "skipped_closed";
          } else if (new Date(bet.join_deadline) <= new Date()) {
            stakeStatus = "skipped_deadline";
          } else {
            // Insert stake using the bet's fixed stake amount, not the deposit amount.
            const stakeAmountCents = Number(bet.stake_amount_cents);
            if (amountCents < stakeAmountCents) {
              stakeStatus = "skipped_insufficient";
            } else {
              const { data: stakeRow, error: stakeErr } = await sb.from("stakes").insert({
                bet_id: tx.intended_bet_id,
                user_id: me.id,
                outcome_chosen: tx.intended_outcome,
                amount_cents: stakeAmountCents,
              }).select("id").single();
              if (stakeErr?.code === "23505") {
                stakeStatus = "skipped_duplicate";
              } else if (stakeErr) {
                stakeStatus = "skipped_error";
              } else {
                // Re-check bet status after insert to close TOCTOU window.
                const { data: freshBet } = await sb
                  .from("bets")
                  .select("status")
                  .eq("id", tx.intended_bet_id)
                  .single();
                if (!freshBet || freshBet.status !== "open") {
                  // Bet closed during deposit — roll back the stake.
                  await sb.from("stakes").delete().eq("id", stakeRow.id);
                  stakeStatus = "skipped_closed";
                } else {
                  // Lock the bet's stake amount in ledger (not the full deposit).
                  await addBalanceEvent({
                    groupId,
                    userId: me.id,
                    deltaCents: -stakeAmountCents,
                    reason: "stake_lock",
                    betId: tx.intended_bet_id,
                    idempotencyKey: `stake_lock:${tx.intended_bet_id}:${me.id}`,
                  });
                  stakeStatus = "created";
                }
              }
            }
          }
        } catch {
          stakeStatus = "skipped_error";
        }
      }

      return Response.json({ status: "completed", stake_status: stakeStatus }, { status: 200 });
    }

    if (result.status === "FAILED") {
      const { error: updErr } = await sb
        .from("transactions")
        .update({
          status: "failed",
          error_message: result.substatus ?? "composer reported FAILED",
          updated_at: new Date().toISOString(),
        })
        .eq("id", depositId);
      if (updErr) throw new HttpError(500, `tx update failed: ${updErr.message}`);
      return Response.json({ status: "failed" }, { status: 200 });
    }

    // PENDING / NOT_FOUND / UNKNOWN — keep polling.
    return Response.json(
      { status: "executing", composerStatus: result.status, substatus: result.substatus },
      { status: 200 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
