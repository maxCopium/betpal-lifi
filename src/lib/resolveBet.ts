import "server-only";
import { supabaseService } from "./supabase";
import { addBalanceEvent } from "./ledger";
import { computePayouts, type Stake } from "./payouts";
import { getMarket, isMarketSettleable } from "./polymarket";

/**
 * Core bet-resolution logic, shared by the user-triggered resolve route and
 * the auto-resolution cron. No auth/membership checks — those live at the
 * route boundary. Caller is responsible for gating who may invoke this.
 *
 * Returns one of:
 *   - { kind: "noop", status }       — bet already terminal or precondition fails
 *   - { kind: "resolving", reason }  — Polymarket not yet settleable
 *   - { kind: "settled", … }         — payouts written, bet flipped
 */
export type ResolveResult =
  | { kind: "noop"; status: string }
  | { kind: "resolving"; reason: string }
  | {
      kind: "settled";
      winningOutcome: string | null;
      refunded: boolean;
      reason: string | null;
      payouts: { userId: string; amountCents: number }[];
    };

/**
 * Advisory lock TTL in milliseconds. If a worker set `processing_started_at`
 * more than this long ago, we consider it stale (crashed) and steal the lock.
 */
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function resolveBetIfPossible(betId: string): Promise<ResolveResult> {
  const sb = supabaseService();
  const { data: bet, error: betErr } = await sb
    .from("bets")
    .select("id, group_id, polymarket_market_id, status, join_deadline, processing_started_at")
    .eq("id", betId)
    .maybeSingle();
  if (betErr) throw new Error(`bet lookup failed: ${betErr.message}`);
  if (!bet) throw new Error("bet not found");

  const status = bet.status as string;
  if (status === "settled" || status === "voided") {
    return { kind: "noop", status };
  }
  if (new Date(bet.join_deadline as string).getTime() > Date.now()) {
    return { kind: "noop", status: "join deadline not passed" };
  }

  // Advisory lock: prevent concurrent cron runs from double-processing the
  // same bet. We set `processing_started_at` to now, but only if it's either
  // null (nobody working on it) or older than LOCK_TTL_MS (stale/crashed).
  const now = new Date();
  const lockCutoff = new Date(now.getTime() - LOCK_TTL_MS).toISOString();
  const { data: lockResult, error: lockErr } = await sb
    .from("bets")
    .update({ processing_started_at: now.toISOString() })
    .eq("id", betId)
    .or(`processing_started_at.is.null,processing_started_at.lt.${lockCutoff}`)
    .select("id");
  if (lockErr) throw new Error(`lock acquisition failed: ${lockErr.message}`);
  if (!lockResult || lockResult.length === 0) {
    // Another worker is actively processing this bet — skip it.
    return { kind: "noop", status: "locked by another worker" };
  }

  const { data: stakeRows, error: stakeErr } = await sb
    .from("stakes")
    .select("user_id, outcome_chosen, amount_cents")
    .eq("bet_id", betId);
  if (stakeErr) throw new Error(`stake fetch failed: ${stakeErr.message}`);
  const stakes: Stake[] = (stakeRows ?? []).map((r) => ({
    userId: r.user_id as string,
    outcomeChosen: r.outcome_chosen as string,
    amountCents: Number(r.amount_cents),
  }));
  const totalPoolCents = stakes.reduce((a, s) => a + s.amountCents, 0);

  const market = await getMarket(bet.polymarket_market_id as string);
  const settle = isMarketSettleable(market);

  if (!settle.settleable) {
    // Release lock and flip to resolving so the next cron tick retries.
    await sb
      .from("bets")
      .update({ status: "resolving", processing_started_at: null })
      .eq("id", betId);
    return { kind: "resolving", reason: settle.reason ?? "not settleable yet" };
  }

  const result = computePayouts({
    stakes,
    winningOutcome: settle.winningOutcome ?? null,
    totalPoolCents,
  });

  for (const p of result.payouts) {
    if (p.amountCents <= 0) continue;
    await addBalanceEvent({
      groupId: bet.group_id as string,
      userId: p.userId,
      deltaCents: p.amountCents,
      reason: "payout",
      betId,
      idempotencyKey: `payout:${betId}:${p.userId}`,
    });
  }

  // Flip to settled and release the advisory lock.
  const { error: updErr } = await sb
    .from("bets")
    .update({
      status: "settled",
      resolution_outcome: settle.winningOutcome ?? null,
      settled_at: new Date().toISOString(),
      resolution_evidence: { source: "polymarket", market_id: bet.polymarket_market_id },
      processing_started_at: null,
    })
    .eq("id", betId);
  if (updErr) throw new Error(`bet update failed: ${updErr.message}`);

  return {
    kind: "settled",
    winningOutcome: settle.winningOutcome ?? null,
    refunded: result.refunded,
    reason: result.reason ?? null,
    payouts: result.payouts,
  };
}
