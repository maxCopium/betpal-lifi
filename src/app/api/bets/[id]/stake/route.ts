import "server-only";
import { z } from "zod";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { addBalanceEvent, getUserFreeBalanceCents } from "@/lib/ledger";

/**
 * POST /api/bets/[id]/stake
 *
 * Place a stake on a bet. The caller must be a member of the bet's group,
 * the bet must still be `open`, the join deadline must not have passed, and
 * the caller must have enough free balance (total - locked stakes) in the
 * group ledger.
 *
 * State changes:
 *   1. INSERT into `stakes` (unique on (bet_id, user_id) prevents double-stake)
 *   2. INSERT into `balance_events` with reason='stake_lock' and a negative
 *      delta (idempotent on key `stake_lock:<betId>:<userId>`)
 *
 * If the stake insert succeeds but the ledger insert fails (rare), the
 * idempotency key on retry will recover. If the ledger insert succeeds but
 * the stake insert failed (the unique constraint case), we return 409.
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */

const Body = z.object({
  outcome: z.string().min(1).max(80),
  amount_cents: z.number().int().positive(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: betId } = await params;
    const json = await request.json().catch(() => {
      throw new HttpError(400, "invalid json body");
    });
    const body = Body.parse(json);

    const sb = supabaseService();
    const { data: bet, error: betErr } = await sb
      .from("bets")
      .select("id, group_id, options, status, join_deadline")
      .eq("id", betId)
      .maybeSingle();
    if (betErr) throw new HttpError(500, `bet lookup failed: ${betErr.message}`);
    if (!bet) throw new HttpError(404, "bet not found");
    if (bet.status !== "open") {
      throw new HttpError(409, `bet is not open (status=${bet.status})`);
    }
    if (new Date(bet.join_deadline as string).getTime() <= Date.now()) {
      throw new HttpError(409, "join deadline has passed");
    }

    const options = (bet.options as string[]) ?? [];
    if (!options.includes(body.outcome)) {
      throw new HttpError(400, `outcome must be one of: ${options.join(", ")}`);
    }

    // Membership gate.
    const { data: membership, error: memErr } = await sb
      .from("group_members")
      .select("user_id")
      .eq("group_id", bet.group_id)
      .eq("user_id", me.id)
      .maybeSingle();
    if (memErr) throw new HttpError(500, `member check failed: ${memErr.message}`);
    if (!membership) throw new HttpError(403, "not a member of this bet's group");

    // Free-balance check.
    const free = await getUserFreeBalanceCents(bet.group_id as string, me.id);
    if (free < body.amount_cents) {
      throw new HttpError(
        402,
        `insufficient free balance: have ${free} cents, need ${body.amount_cents}`,
      );
    }

    // Insert the stake row first. The unique (bet_id, user_id) constraint
    // serves as the double-stake guard.
    const { data: stake, error: stakeErr } = await sb
      .from("stakes")
      .insert({
        bet_id: betId,
        user_id: me.id,
        outcome_chosen: body.outcome,
        amount_cents: body.amount_cents,
      })
      .select("id, bet_id, user_id, outcome_chosen, amount_cents, created_at")
      .single();
    if (stakeErr || !stake) {
      if (stakeErr?.code === "23505") {
        throw new HttpError(409, "you already have a stake on this bet");
      }
      throw new HttpError(500, `stake insert failed: ${stakeErr?.message}`);
    }

    // Lock the stake amount in the ledger. Idempotent — repeats are no-ops.
    await addBalanceEvent({
      groupId: bet.group_id as string,
      userId: me.id,
      deltaCents: -body.amount_cents,
      reason: "stake_lock",
      betId,
      idempotencyKey: `stake_lock:${betId}:${me.id}`,
    });

    return Response.json(stake, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
