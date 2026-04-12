import "server-only";
import { z } from "zod";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { addBalanceEvent, getUserFreeBalanceCents } from "@/lib/ledger";
import { getMarket, isMockMarket, getMockMarketData } from "@/lib/polymarket";

/**
 * POST /api/bets/[id]/stake
 *
 * Place a stake on a bet. Everyone pays the same fixed amount (set at bet
 * creation). The caller chooses their outcome only — amount is enforced.
 *
 * State changes:
 *   1. INSERT into `stakes` (unique on (bet_id, user_id) prevents double-stake)
 *   2. INSERT into `balance_events` with reason='stake_lock' and a negative
 *      delta (idempotent on key `stake_lock:<betId>:<userId>`)
 */

const Body = z.object({
  outcome: z.string().min(1).max(80),
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
      .select("id, group_id, options, status, join_deadline, stake_amount_cents, polymarket_market_id")
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

    const stakeAmount = Number(bet.stake_amount_cents);

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
    if (free < stakeAmount) {
      throw new HttpError(
        402,
        `insufficient free balance: have ${free} cents, need ${stakeAmount}`,
      );
    }

    // Capture live Polymarket price for display (informational only — not used for payouts).
    let oddsAtStake: number | null = null;
    try {
      const marketId = bet.polymarket_market_id as string;
      let outcomes: string[] = [];
      let prices: number[] = [];
      if (isMockMarket(marketId)) {
        const mock = getMockMarketData(marketId);
        if (mock) {
          outcomes = Array.isArray(mock.outcomes) ? mock.outcomes.map(String) : JSON.parse(mock.outcomes as string);
          prices = Array.isArray(mock.outcomePrices) ? mock.outcomePrices.map(Number) : JSON.parse(mock.outcomePrices as string).map(Number);
        }
      } else {
        const market = await getMarket(marketId);
        const parseArr = (v: unknown): string[] | null => {
          if (Array.isArray(v)) return v.map(String);
          if (typeof v === "string") { try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(String) : null; } catch { return null; } }
          return null;
        };
        outcomes = parseArr(market.outcomes) ?? [];
        prices = (parseArr(market.outcomePrices) ?? []).map(Number);
      }
      const idx = outcomes.indexOf(body.outcome);
      if (idx >= 0 && idx < prices.length && Number.isFinite(prices[idx])) {
        oddsAtStake = prices[idx];
      }
    } catch {
      // Non-critical — proceed without odds
    }

    // Insert the stake row. Amount enforced from bet — not user-provided.
    const { data: stake, error: stakeErr } = await sb
      .from("stakes")
      .insert({
        bet_id: betId,
        user_id: me.id,
        outcome_chosen: body.outcome,
        amount_cents: stakeAmount,
        odds_at_stake: oddsAtStake,
      })
      .select("id, bet_id, user_id, outcome_chosen, amount_cents, odds_at_stake, created_at")
      .single();
    if (stakeErr || !stake) {
      if (stakeErr?.code === "23505") {
        throw new HttpError(409, "you already have a stake on this bet");
      }
      throw new HttpError(500, `stake insert failed: ${stakeErr?.message}`);
    }

    // Lock the stake amount in the ledger.
    await addBalanceEvent({
      groupId: bet.group_id as string,
      userId: me.id,
      deltaCents: -stakeAmount,
      reason: "stake_lock",
      betId,
      idempotencyKey: `stake_lock:${betId}:${me.id}`,
    });

    return Response.json(stake, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
