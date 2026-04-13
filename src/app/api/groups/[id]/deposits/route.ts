import "server-only";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { getComposerQuote, type LifiQuote } from "@/lib/composer";
import { BASE_CHAIN_ID } from "@/lib/constants";

/**
 * POST /api/groups/:id/deposits
 *
 * Phase 1 of the two-phase deposit flow.
 *
 *   Phase 1 (this route):
 *     - Caller specifies fromChain/fromToken/fromAmount.
 *     - We fetch a LI.FI Composer quote with `toToken` set to the group's
 *       Morpho vault address. Composer atomically handles swap + approve +
 *       vault.deposit() — shares are minted to the group wallet.
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
 *       row + the group to `active`. No server-side vault deposit needed —
 *       Composer already deposited directly into the vault.
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */

const Body = z
  .object({
    fromChain: z.number().int().positive(),
    fromToken: z.string().min(1),
    fromAmount: z.string().regex(/^\d+$/, "fromAmount must be a base-units integer string"),
    betId: z.string().uuid().optional(),
    outcome: z.string().min(1).max(80).optional(),
  })
  .refine((d) => (d.betId == null) === (d.outcome == null), {
    message: "betId and outcome must both be present or both absent",
  });

/**
 * Derive ledger cents from the Composer quote's USD estimate.
 *
 * When toToken is the Morpho vault, toAmountMin is in vault shares (18 decimals),
 * not USDC (6 decimals). The quote's `toAmountUSD` field gives us the USD value
 * regardless of toToken denomination.
 *
 * If toAmountUSD is missing, we cannot safely derive cents from vault share units,
 * so we reject the quote.
 */
function quoteToAmountCents(quote: LifiQuote): number {
  if (!quote.estimate.toAmountUSD) {
    throw new Error(
      "Composer quote missing toAmountUSD — cannot derive ledger cents from vault share units",
    );
  }
  const usd = parseFloat(quote.estimate.toAmountUSD);
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(`Composer toAmountUSD is invalid: ${quote.estimate.toAmountUSD}`);
  }
  if (usd > 1_000_000) {
    throw new Error(`Composer toAmountUSD suspiciously large: $${usd} — rejecting`);
  }
  return Math.round(usd * 100);
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

    // Validate bet intent if provided.
    if (body.betId && body.outcome) {
      const { data: bet, error: betErr } = await sb
        .from("bets")
        .select("id, group_id, status, options, join_deadline")
        .eq("id", body.betId)
        .single();
      if (betErr || !bet) throw new HttpError(404, "bet not found");
      if (bet.group_id !== groupId) throw new HttpError(400, "bet does not belong to this group");
      if (bet.status !== "open") throw new HttpError(409, "bet is no longer open");
      if (new Date(bet.join_deadline) <= new Date()) throw new HttpError(409, "bet join deadline has passed");
      const options = bet.options as string[];
      if (!options.includes(body.outcome)) throw new HttpError(400, `invalid outcome: ${body.outcome}`);
      const { data: existingStake } = await sb
        .from("stakes")
        .select("id")
        .eq("bet_id", body.betId)
        .eq("user_id", me.id)
        .maybeSingle();
      if (existingStake) throw new HttpError(409, "you already have a stake on this bet");
    }

    // Look up the group's wallet.
    const { data: group, error: groupErr } = await sb
      .from("groups")
      .select("id, wallet_address, vault_address, vault_chain_id, privy_wallet_id, status")
      .eq("id", groupId)
      .single();
    if (groupErr || !group) {
      throw new HttpError(500, `group lookup failed: ${groupErr?.message}`);
    }
    if (!group.wallet_address) throw new HttpError(409, "group wallet not initialized yet");

    // Quote: route the user's funds directly into the Morpho vault on Base.
    // Composer handles swap + approve + vault.deposit() atomically.
    // Vault shares are minted to the group wallet (toAddress).
    const vaultAddress = group.vault_address as string;
    if (!vaultAddress) throw new HttpError(409, "group vault not configured");

    const quote = await getComposerQuote({
      fromChain: body.fromChain,
      toChain: BASE_CHAIN_ID,
      fromToken: body.fromToken,
      toToken: vaultAddress,
      fromAmount: body.fromAmount,
      fromAddress: me.walletAddress,
      toAddress: group.wallet_address as string,
    });

    // Derive cents from the Composer quote's USD value.
    const amountCents = quoteToAmountCents(quote);
    if (amountCents <= 0) {
      throw new HttpError(400, "quote toAmountMin too small to credit any cents");
    }

    // Insert pending transactions row. Use a deterministic-enough idempotency
    // key combining quote id + caller — this prevents accidental duplicates if
    // the user clicks "Quote" twice with the same inputs.
    const idempotencyKey = body.betId
      ? `deposit_quote:${quote.id}:${me.id}:${body.betId}`
      : `deposit_quote:${quote.id}:${me.id}`;
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
        dest_chain: BASE_CHAIN_ID,
        dest_token: vaultAddress,
        composer_route_id: quote.id,
        status: "pending",
        idempotency_key: idempotencyKey,
        intended_bet_id: body.betId ?? null,
        intended_outcome: body.outcome ?? null,
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
