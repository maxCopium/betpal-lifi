import "server-only";
import { z } from "zod";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";

/**
 * PATCH /api/groups/:id/withdrawals/:withdrawalId
 *
 * Phase 2 of the withdrawal flow. The caller has gathered enough Safe
 * co-signatures and submitted the on-chain transaction; here they report the
 * resulting tx hash so we can poll its Composer status.
 *
 * Mirrors the deposit PATCH endpoint exactly so the client-side flow can
 * share polling code.
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */

const Body = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]+$/, "txHash must be 0x-hex"),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; withdrawalId: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId, withdrawalId } = await params;
    const json = await request.json().catch(() => {
      throw new HttpError(400, "invalid json body");
    });
    const body = Body.parse(json);

    const sb = supabaseService();
    const { data: tx, error: txErr } = await sb
      .from("transactions")
      .select("id, group_id, user_id, status, type")
      .eq("id", withdrawalId)
      .maybeSingle();
    if (txErr) throw new HttpError(500, `tx lookup failed: ${txErr.message}`);
    if (!tx) throw new HttpError(404, "withdrawal not found");
    if (tx.type !== "withdrawal") throw new HttpError(400, "row is not a withdrawal");
    if (tx.group_id !== groupId)
      throw new HttpError(400, "withdrawal does not belong to this group");
    if (tx.user_id !== me.id) throw new HttpError(403, "not your withdrawal");
    if (tx.status !== "pending" && tx.status !== "executing") {
      throw new HttpError(409, `withdrawal is in terminal state: ${tx.status}`);
    }

    const { error: updErr } = await sb
      .from("transactions")
      .update({
        tx_hash: body.txHash,
        status: "executing",
        updated_at: new Date().toISOString(),
      })
      .eq("id", withdrawalId);
    if (updErr) throw new HttpError(500, `tx update failed: ${updErr.message}`);

    return Response.json({ withdrawalId, status: "executing" }, { status: 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
