import "server-only";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { getComposerQuote } from "@/lib/composer";

/**
 * POST /api/groups/:id/deposits
 *
 * Phase 1 of the two-phase deposit flow.
 *
 *   Phase 1 (this route):
 *     - Caller specifies fromChain/fromToken/fromAmount.
 *     - We fetch a LI.FI Composer quote with `toToken` set to the group's
 *       Morpho vault address, so the route ends in a vault deposit on Base.
 *     - We insert a `transactions` row in status `pending` to track the
 *       lifecycle. The id of that row is returned alongside the quote.
 *
 *   Phase 2 (PATCH /api/groups/:id/deposits/:depositId):
 *     - Caller signs the quote's transactionRequest with their embedded
 *       wallet, broadcasts, and reports the tx hash. We flip the row to
 *       `executing`.
 *
 *   Phase 3 (POST /api/groups/:id/deposits/:depositId/confirm):
 *     - We poll Composer's /status endpoint and, on `DONE`, write a
 *       `balance_events` deposit credit (idempotent on tx hash) and flip the
 *       row + the group to `active`.
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */

const Body = z.object({
  fromChain: z.number().int().positive(),
  fromToken: z.string().min(1),
  fromAmount: z.string().regex(/^\d+$/, "fromAmount must be a base-units integer string"),
});

/**
 * Derive ledger cents from Composer's guaranteed minimum output (toAmountMin).
 * The vault receives USDC (6 decimals): 1 USDC = 1_000_000 base units = 100 cents.
 * So 1 cent = 10_000 base units.
 *
 * We use toAmountMin (post-slippage floor) rather than toAmount (estimate) to
 * avoid crediting more than the vault actually received.
 */
function quoteToAmountCents(toAmountMin: string): number {
  const raw = BigInt(toAmountMin);
  return Number(raw / BigInt(10_000));
}

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

    // Membership gate.
    const { data: membership, error: memErr } = await sb
      .from("group_members")
      .select("user_id")
      .eq("group_id", groupId)
      .eq("user_id", me.id)
      .maybeSingle();
    if (memErr) throw new HttpError(500, `member check failed: ${memErr.message}`);
    if (!membership) throw new HttpError(403, "not a member of this group");

    // Look up the group's safe + vault.
    const { data: group, error: groupErr } = await sb
      .from("groups")
      .select("id, safe_address, vault_address, vault_chain_id, status")
      .eq("id", groupId)
      .single();
    if (groupErr || !group) {
      throw new HttpError(500, `group lookup failed: ${groupErr?.message}`);
    }
    if (!group.safe_address) throw new HttpError(409, "group has no safe address yet");

    // Quote: route the user's funds into the vault token, with the Safe as
    // the recipient.
    const quote = await getComposerQuote({
      fromChain: body.fromChain,
      toChain: Number(group.vault_chain_id),
      fromToken: body.fromToken,
      toToken: group.vault_address as string,
      fromAmount: body.fromAmount,
      fromAddress: me.walletAddress,
      toAddress: group.safe_address as string,
    });

    // Derive cents from the Composer oracle — never trust user-supplied amounts.
    const amountCents = quoteToAmountCents(quote.estimate.toAmountMin);
    if (amountCents <= 0) {
      throw new HttpError(400, "quote toAmountMin too small to credit any cents");
    }

    // Insert pending transactions row. Use a deterministic-enough idempotency
    // key combining quote id + caller — this prevents accidental duplicates if
    // the user clicks "Quote" twice with the same inputs.
    const idempotencyKey = `deposit_quote:${quote.id}:${me.id}`;
    const depositId = randomUUID();
    const { data: txRow, error: txErr } = await sb
      .from("transactions")
      .insert({
        id: depositId,
        group_id: groupId,
        user_id: me.id,
        type: "deposit",
        amount_cents: amountCents,
        source_chain: body.fromChain,
        source_token: body.fromToken,
        dest_chain: Number(group.vault_chain_id),
        dest_token: group.vault_address as string,
        composer_route_id: quote.id,
        status: "pending",
        idempotency_key: idempotencyKey,
      })
      .select("id")
      .single();
    if (txErr) {
      // Idempotent retry: if the row already exists, fetch and return it.
      if (txErr.code === "23505") {
        const { data: existing, error: exErr } = await sb
          .from("transactions")
          .select("id")
          .eq("idempotency_key", idempotencyKey)
          .single();
        if (exErr || !existing) {
          throw new HttpError(500, `idempotent fetch failed: ${exErr?.message}`);
        }
        return Response.json({ depositId: existing.id, quote }, { status: 200 });
      }
      throw new HttpError(500, `tx insert failed: ${txErr.message}`);
    }

    return Response.json({ depositId: txRow.id, quote }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
