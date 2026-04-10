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
        "id, group_id, user_id, status, tx_hash, source_chain, dest_chain, amount_cents",
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
      // Validate amount_cents is present and positive. A null/zero value means
      // the deposit was created without an amount — we must reject rather than
      // silently credit 0, which would lose the user's on-chain deposit.
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

      const { error: updErr } = await sb
        .from("transactions")
        .update({
          status: "completed",
          actual_amount_cents: amountCents,
          updated_at: new Date().toISOString(),
        })
        .eq("id", depositId);
      if (updErr) throw new HttpError(500, `tx update failed: ${updErr.message}`);

      // Promote group to active on first successful deposit. Membership freezes
      // from this point — see /api/invites/[token]/accept.
      await sb
        .from("groups")
        .update({ status: "active" })
        .eq("id", groupId)
        .eq("status", "pending");

      return Response.json({ status: "completed" }, { status: 200 });
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
