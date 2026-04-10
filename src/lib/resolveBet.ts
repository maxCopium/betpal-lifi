import "server-only";
import { supabaseService } from "./supabase";
import { addBalanceEvent, getGroupTotalCents } from "./ledger";
import { computePayouts, type Stake } from "./payouts";
import { getMarket, isMarketSettleable } from "./polymarket";
import { getVaultBalanceCents } from "./vault";

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
      yieldCredited: number; // total yield cents distributed to winners
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

  // ── Yield distribution to winners ──────────────────────────────────────
  // The group vault accrues yield while funds sit in Morpho. On settlement
  // we read the on-chain balance, compare it to the ledger, and distribute
  // any positive drift (= accrued yield) to winners proportionally to their
  // payout share. This is idempotent via `yield_credit:<betId>:<userId>`.
  //
  // If the vault read fails (Safe not deployed, RPC down), we skip yield
  // distribution silently — payouts are still correct, yield just stays
  // uncredited until the next reconciliation or resolution.
  let yieldCredited = 0;
  const winnerPayouts = result.payouts.filter((p) => p.amountCents > 0);
  if (winnerPayouts.length > 0 && !result.refunded) {
    try {
      const groupId = bet.group_id as string;
      const { data: group } = await sb
        .from("groups")
        .select("safe_address, vault_address")
        .eq("id", groupId)
        .single();

      if (group?.safe_address && group?.vault_address) {
        const onChainCents = await getVaultBalanceCents(
          group.vault_address as `0x${string}`,
          group.safe_address as `0x${string}`,
        );
        if (onChainCents !== null) {
          const ledgerCents = await getGroupTotalCents(groupId);
          const yieldCents = Math.max(0, onChainCents - ledgerCents);

          if (yieldCents > 0) {
            // Distribute proportionally to winners using integer math (same
            // largest-remainder approach as payout distribution).
            const totalPayoutCents = winnerPayouts.reduce(
              (a, p) => a + p.amountCents,
              0,
            );
            let distributed = 0;
            const shares = winnerPayouts.map((p) => {
              const raw = Math.floor(
                (p.amountCents / totalPayoutCents) * yieldCents,
              );
              distributed += raw;
              return { userId: p.userId, cents: raw };
            });
            // Give remainder to the largest winner (deterministic).
            let remainder = yieldCents - distributed;
            if (remainder > 0) {
              shares.sort((a, b) => b.cents - a.cents);
              shares[0].cents += remainder;
              remainder = 0;
            }

            for (const s of shares) {
              if (s.cents <= 0) continue;
              await addBalanceEvent({
                groupId,
                userId: s.userId,
                deltaCents: s.cents,
                reason: "yield_credit",
                betId,
                idempotencyKey: `yield_credit:${betId}:${s.userId}`,
              });
              yieldCredited += s.cents;
            }
          }
        }
      }
    } catch (e) {
      // Yield distribution is best-effort — don't block settlement.
      console.warn("yield distribution failed:", (e as Error).message);
    }
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
    yieldCredited,
  };
}
