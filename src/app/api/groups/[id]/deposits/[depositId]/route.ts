import "server-only";
import { z } from "zod";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";

/**
 * PATCH /api/groups/:id/deposits/:depositId
 *
 * Phase 2 of the deposit flow. The caller has signed + broadcast the
 * transaction returned by Composer; here they report the resulting tx hash.
 *
 * We flip the row from `pending` to `executing` and stash the hash. Confirm
 * (Phase 3) is a separate endpoint that polls Composer's /status.
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */

const Body = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]+$/, "txHash must be 0x-hex"),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; depositId: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId, depositId } = await params;
    const json = await request.json().catch(() => {
      throw new HttpError(400, "invalid json body");
    });
    const body = Body.parse(json);

    const sb = supabaseService();

    // Ownership: only the user who created the deposit row may update it.
    const { data: tx, error: txErr } = await sb
      .from("transactions")
      .select("id, group_id, user_id, status")
      .eq("id", depositId)
      .maybeSingle();
    if (txErr) throw new HttpError(500, `tx lookup failed: ${txErr.message}`);
    if (!tx) throw new HttpError(404, "deposit not found");
    if (tx.group_id !== groupId) throw new HttpError(400, "deposit does not belong to this group");
    if (tx.user_id !== me.id) throw new HttpError(403, "not your deposit");
    if (tx.status !== "pending" && tx.status !== "executing") {
      throw new HttpError(409, `deposit is in terminal state: ${tx.status}`);
    }

    const { error: updErr } = await sb
      .from("transactions")
      .update({
        tx_hash: body.txHash,
        status: "executing",
        updated_at: new Date().toISOString(),
      })
      .eq("id", depositId);
    if (updErr) throw new HttpError(500, `tx update failed: ${updErr.message}`);

    return Response.json({ depositId, status: "executing" }, { status: 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
