import "server-only";
import { supabaseService } from "./supabase";
import { addBalanceEvent, getGroupTotalCents } from "./ledger";
import { computePayouts, type Stake } from "./payouts";
import { getMarket, isMarketSettleable } from "./polymarket";
import { getVaultBalanceCents, redeemFromVault, PartialRedeemError } from "./vault";

/**
 * Core bet-resolution logic. Shared by the user-triggered resolve route and
 * the auto-resolution cron. No auth/membership checks — those live at the
 * route boundary.
 *
 * Equal-stakes model:
 *   - Winners split the pool equally.
 *   - If all stakers picked the same side → release locks (money stays in group).
 *   - If < 2 stakers at resolution → release locks.
 *   - No refunds — just stake-lock reversals.
 */
export type ResolveResult =
  | { kind: "noop"; status: string }
  | { kind: "resolving"; reason: string }
  | {
      kind: "settled";
      winningOutcome: string | null;
      released: boolean;
      reason: string | null;
      payouts: { userId: string; amountCents: number }[];
      yieldCredited: number;
    };

const LOCK_TTL_MS = 5 * 60 * 1000;

export async function resolveBetIfPossible(betId: string): Promise<ResolveResult> {
  const sb = supabaseService();
  const { data: bet, error: betErr } = await sb
    .from("bets")
    .select("id, group_id, polymarket_market_id, status, join_deadline, processing_started_at, mock_resolved_outcome")
    .eq("id", betId)
    .maybeSingle();
  if (betErr) throw new Error(`bet lookup failed: ${betErr.message}`);
  if (!bet) throw new Error("bet not found");

  const status = bet.status as string;
  if (status === "settled" || status === "voided") {
    return { kind: "noop", status };
  }
  const hasManualOutcome = !!(bet.mock_resolved_outcome as string | null);
  const isMock = (bet.polymarket_market_id as string).startsWith("mock:");
  // Skip deadline check for manually resolved bets (demo) and mock markets
  if (!hasManualOutcome && !isMock && new Date(bet.join_deadline as string).getTime() > Date.now()) {
    return { kind: "noop", status: "join deadline not passed" };
  }

  // Advisory lock
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

  // ── Same-side check (before market check) ──
  // If < 2 stakers or everyone picked the same side, void immediately.
  const distinctOutcomes = new Set(stakes.map((s) => s.outcomeChosen));
  if (stakes.length < 2 || distinctOutcomes.size < 2) {
    // Release all stake locks — money goes back to free balance.
    for (const s of stakes) {
      await addBalanceEvent({
        groupId: bet.group_id as string,
        userId: s.userId,
        deltaCents: s.amountCents,
        reason: "stake_refund",
        betId,
        idempotencyKey: `stake_release:${betId}:${s.userId}`,
      });
    }
    const reason = stakes.length < 2 ? "not enough participants" : "all on same side";
    await sb.from("bets").update({
      status: "voided",
      resolution_outcome: null,
      settled_at: now.toISOString(),
      resolution_evidence: { reason },
      processing_started_at: null,
    }).eq("id", betId);

    return {
      kind: "settled",
      winningOutcome: null,
      released: true,
      reason,
      payouts: stakes.map((s) => ({ userId: s.userId, amountCents: s.amountCents })),
      yieldCredited: 0,
    };
  }

  // ── Check Polymarket ──
  const market = await getMarket(bet.polymarket_market_id as string);
  const settle = isMarketSettleable(
    market,
    new Date(),
    (bet.mock_resolved_outcome as string | null) ?? undefined,
  );

  if (!settle.settleable) {
    await sb
      .from("bets")
      .update({ status: "resolving", processing_started_at: null })
      .eq("id", betId);
    return { kind: "resolving", reason: settle.reason ?? "not settleable yet" };
  }

  const groupId = bet.group_id as string;
  const result = computePayouts({
    stakes,
    winningOutcome: settle.winningOutcome ?? null,
    totalPoolCents,
  });

  if (result.released) {
    // Release case (void, no_winners, etc.): reverse stake locks.
    for (const p of result.payouts) {
      if (p.amountCents <= 0) continue;
      await addBalanceEvent({
        groupId,
        userId: p.userId,
        deltaCents: p.amountCents,
        reason: "stake_refund",
        betId,
        idempotencyKey: `stake_release:${betId}:${p.userId}`,
      });
    }

    await sb.from("bets").update({
      status: "voided",
      resolution_outcome: settle.winningOutcome ?? null,
      settled_at: now.toISOString(),
      resolution_evidence: { source: "polymarket", market_id: bet.polymarket_market_id, reason: result.reason },
      processing_started_at: null,
    }).eq("id", betId);

    return {
      kind: "settled",
      winningOutcome: settle.winningOutcome ?? null,
      released: true,
      reason: result.reason ?? null,
      payouts: result.payouts,
      yieldCredited: 0,
    };
  }

  // ── Winners take the pool ──
  for (const p of result.payouts) {
    if (p.amountCents <= 0) continue;
    await addBalanceEvent({
      groupId,
      userId: p.userId,
      deltaCents: p.amountCents,
      reason: "payout",
      betId,
      idempotencyKey: `payout:${betId}:${p.userId}`,
    });
  }

  // ── Yield distribution to winners ──
  let yieldCredited = 0;
  const winnerPayouts = result.payouts.filter((p) => p.amountCents > 0);
  if (winnerPayouts.length > 0) {
    try {
      const { data: group } = await sb
        .from("groups")
        .select("wallet_address, vault_address, privy_wallet_id")
        .eq("id", groupId)
        .single();

      if (group?.wallet_address && group.vault_address) {
        const onChainCents = await getVaultBalanceCents(
          group.vault_address as `0x${string}`,
          group.wallet_address as `0x${string}`,
        );
        if (onChainCents !== null) {
          const ledgerCents = await getGroupTotalCents(groupId);
          const yieldCents = Math.max(0, onChainCents - ledgerCents);

          if (yieldCents > 0) {
            const totalPayoutCents = winnerPayouts.reduce((a, p) => a + p.amountCents, 0);
            let distributed = 0;
            const shares = winnerPayouts.map((p) => {
              const raw = Math.floor((p.amountCents * yieldCents) / totalPayoutCents);
              distributed += raw;
              return { userId: p.userId, cents: raw };
            });
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
      console.warn("yield distribution failed:", (e as Error).message);
    }
  }

  // ── Auto-payout (best-effort) ──
  const allPayouts = result.payouts.filter((p) => p.amountCents > 0);
  let groupData: { privy_wallet_id: string; wallet_address: string; vault_address: string } | null = null;
  if (allPayouts.length > 0) {
    const { data: gw } = await sb
      .from("groups")
      .select("privy_wallet_id, wallet_address, vault_address")
      .eq("id", groupId)
      .single();
    if (gw?.privy_wallet_id && gw?.wallet_address && gw?.vault_address) {
      groupData = gw as { privy_wallet_id: string; wallet_address: string; vault_address: string };
    }
  }

  for (const p of allPayouts) {
    try {
      if (!groupData) continue;
      const { data: user } = await sb
        .from("users")
        .select("wallet_address")
        .eq("id", p.userId)
        .single();
      if (!user?.wallet_address) continue;

      const { data: existing } = await sb
        .from("balance_events")
        .select("id")
        .eq("idempotency_key", `auto_payout:${betId}:${p.userId}`)
        .maybeSingle();
      if (existing) continue;

      await redeemFromVault(
        groupData.privy_wallet_id,
        groupData.vault_address as `0x${string}`,
        groupData.wallet_address as `0x${string}`,
        p.amountCents,
        user.wallet_address as `0x${string}`,
      );

      await addBalanceEvent({
        groupId,
        userId: p.userId,
        deltaCents: -p.amountCents,
        reason: "adjustment",
        betId,
        idempotencyKey: `auto_payout:${betId}:${p.userId}`,
      });
    } catch (e) {
      if (e instanceof PartialRedeemError) {
        // Vault shares already redeemed — USDC is in group wallet.
        // Write the debit event to prevent re-redeeming on any retry.
        // The USDC sits in the group wallet until manual recovery.
        console.error(
          `PARTIAL REDEEM for ${p.userId} on bet ${betId}: ${e.message}. ` +
          `USDC is in group wallet — needs manual transfer.`,
        );
        await addBalanceEvent({
          groupId,
          userId: p.userId,
          deltaCents: -p.amountCents,
          reason: "adjustment",
          betId,
          idempotencyKey: `auto_payout:${betId}:${p.userId}`,
        });
      } else {
        console.warn(`auto-payout failed for ${p.userId}:`, (e as Error).message);
      }
    }
  }

  // Flip to settled
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
    released: false,
    reason: result.reason ?? null,
    payouts: result.payouts,
    yieldCredited,
  };
}
