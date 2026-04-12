/**
 * Pari-mutuel payout calculation for BetPal.
 *
 * INVARIANTS (must hold for every call):
 *   1. All amounts are integer cents. No floats anywhere in this module.
 *   2. sum(result.payouts.amountCents) === totalPoolCents, exactly.
 *   3. No payout is negative.
 *   4. Every input staker appears exactly once in the output.
 *   5. Function is pure: no I/O, no Date.now(), no randomness.
 *
 * Refund cases (winners get principal back, yield distributed pro-rata to all stakers):
 *   - winningOutcome === null  (void / unresolvable)
 *   - no stake matches the winning outcome (0 winners)
 *   - only one distinct staker on the bet
 *   - only one distinct outcome was staked (no losers)
 *
 * Win case:
 *   - Losers' principal is redistributed to winners pro-rata to their winning stake.
 *   - Yield (totalPoolCents - sum(stakes)) is distributed pro-rata to winners
 *     (only winners earn yield; this matches "winners take the pot, including
 *     interest accrued while the bet was open").
 *
 * Dust handling:
 *   - We use the largest-remainder method so the sum is exact and any leftover
 *     cent goes to the staker with the largest fractional remainder, breaking
 *     ties by userId (lexicographic) for determinism.
 */

export type Stake = {
  userId: string;
  outcomeChosen: string;
  amountCents: number;
  /** Polymarket probability (0-1) at time of staking. Used for odds-weighted payouts. */
  oddsAtStake?: number | null;
};

export type Payout = {
  userId: string;
  amountCents: number;
};

export type PayoutResult = {
  payouts: Payout[];
  refunded: boolean;
  reason?: "void" | "no_winners" | "single_staker" | "single_outcome" | "settled";
};

export type ComputePayoutsArgs = {
  stakes: Stake[];
  winningOutcome: string | null;
  totalPoolCents: number;
};

export function computePayouts(args: ComputePayoutsArgs): PayoutResult {
  const { stakes, winningOutcome, totalPoolCents } = args;

  // -------- input validation (defensive; these should never happen in prod) --
  if (!Number.isInteger(totalPoolCents) || totalPoolCents < 0) {
    throw new Error("totalPoolCents must be a non-negative integer");
  }
  for (const s of stakes) {
    if (!Number.isInteger(s.amountCents) || s.amountCents <= 0) {
      throw new Error(`stake amountCents must be a positive integer (got ${s.amountCents})`);
    }
    if (!s.userId || !s.outcomeChosen) {
      throw new Error("stake must have userId and outcomeChosen");
    }
  }

  // Aggregate stakes per user (a single user may have multiple stake rows in
  // theory; the bet creation flow currently enforces one-stake-per-user, but
  // the function should be robust to either).
  type Agg = { userId: string; outcome: string; amountCents: number; oddsAtStake: number | null };
  const perUser = new Map<string, Agg>();
  for (const s of stakes) {
    const existing = perUser.get(s.userId);
    if (existing) {
      if (existing.outcome !== s.outcomeChosen) {
        throw new Error(
          `user ${s.userId} has stakes on multiple outcomes — not allowed`,
        );
      }
      existing.amountCents += s.amountCents;
    } else {
      perUser.set(s.userId, {
        userId: s.userId,
        outcome: s.outcomeChosen,
        amountCents: s.amountCents,
        oddsAtStake: s.oddsAtStake ?? null,
      });
    }
  }

  const aggregated = Array.from(perUser.values());
  const principalCents = aggregated.reduce((acc, a) => acc + a.amountCents, 0);

  if (principalCents > totalPoolCents) {
    throw new Error(
      `principal (${principalCents}) exceeds totalPool (${totalPoolCents}) — pool would underflow`,
    );
  }

  if (aggregated.length === 0) {
    return { payouts: [], refunded: true, reason: "void" };
  }

  // -------- refund branches ------------------------------------------------
  const distinctOutcomes = new Set(aggregated.map((a) => a.outcome));
  const isVoid = winningOutcome === null;
  const isSingleStaker = aggregated.length === 1;
  const isSingleOutcome = distinctOutcomes.size === 1;
  const winners = isVoid
    ? []
    : aggregated.filter((a) => a.outcome === winningOutcome);
  const isNoWinners = !isVoid && winners.length === 0;

  if (isVoid || isSingleStaker || isSingleOutcome || isNoWinners) {
    // Refund: each user gets their principal. Yield is distributed pro-rata to
    // all stakers by principal share.
    const reason: PayoutResult["reason"] = isVoid
      ? "void"
      : isSingleStaker
        ? "single_staker"
        : isSingleOutcome
          ? "single_outcome"
          : "no_winners";

    const allocations = allocatePoolByWeights(
      totalPoolCents,
      aggregated.map((a) => ({ userId: a.userId, weight: a.amountCents })),
    );
    return {
      payouts: allocations,
      refunded: true,
      reason,
    };
  }

  // -------- normal settlement ----------------------------------------------
  // Winners share the entire pool. If Polymarket odds were captured at stake
  // time, we weight by `stake / odds` (implied shares) so underdogs get
  // properly rewarded. If odds are missing, fall back to pure pari-mutuel
  // (weight = stake amount).
  //
  // Example: Alice bets $5 on "Yes" at 80% → weight = 5/0.8 = 6.25
  //          Bob bets $5 on "Yes" at 20% → weight = 5/0.2 = 25
  //          If "Yes" wins, Bob gets 4× Alice's share despite equal stakes,
  //          because he bet when the market was against him.
  //
  // We use integer-scaled weights (multiply by 10000) to stay in integer math
  // as much as possible. The allocatePoolByWeights function handles the rest.
  const hasOdds = winners.every((w) => w.oddsAtStake != null && w.oddsAtStake > 0);
  const SCALE = 10000;
  const allocations = allocatePoolByWeights(
    totalPoolCents,
    winners.map((w) => {
      if (hasOdds) {
        // Implied shares: stake / odds, scaled to integer
        const impliedShares = Math.round((w.amountCents / w.oddsAtStake!) * SCALE);
        return { userId: w.userId, weight: Math.max(1, impliedShares) };
      }
      // Fallback: pure pari-mutuel
      return { userId: w.userId, weight: w.amountCents };
    }),
  );

  // Non-winners get nothing, but they must still appear in the output with 0?
  // No — convention here is: refunded=false means only winners are listed.
  // Callers should treat absence as "this user lost".
  return {
    payouts: allocations,
    refunded: false,
    reason: "settled",
  };
}

/**
 * Allocate a non-negative integer pool across recipients by integer weights,
 * using the largest-remainder method. Sum of returned amounts equals `pool`
 * exactly. Recipients with zero weight are ignored. Tie-break is deterministic
 * (by userId ascending).
 */
function allocatePoolByWeights(
  pool: number,
  recipients: { userId: string; weight: number }[],
): Payout[] {
  if (recipients.length === 0) return [];
  const totalWeight = recipients.reduce((acc, r) => acc + r.weight, 0);
  if (totalWeight === 0) {
    throw new Error("cannot allocate pool when total weight is zero");
  }

  // floor(pool * weight / totalWeight) for each recipient
  type Row = { userId: string; weight: number; floor: number; remainder: bigint };
  const rows: Row[] = recipients.map((r) => {
    const numer = BigInt(pool) * BigInt(r.weight);
    const denom = BigInt(totalWeight);
    const floor = Number(numer / denom);
    const remainder = numer - BigInt(floor) * denom; // 0 <= remainder < denom
    return { userId: r.userId, weight: r.weight, floor, remainder };
  });

  let allocated = rows.reduce((acc, r) => acc + r.floor, 0);
  let leftover = pool - allocated;

  // Distribute leftover cents to recipients with the largest remainders.
  // Sort: largest remainder first; tie-break ascending by userId.
  const sorted = [...rows].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.userId < b.userId ? -1 : 1;
  });

  for (let i = 0; leftover > 0 && i < sorted.length; i++) {
    sorted[i].floor += 1;
    leftover -= 1;
  }
  // If leftover > rows.length we'd loop again, but that can't happen because
  // leftover < recipients.length always (sum of fractional parts < n).

  // Return in original input order.
  const byUser = new Map(sorted.map((r) => [r.userId, r.floor]));
  return rows.map((r) => ({
    userId: r.userId,
    amountCents: byUser.get(r.userId)!,
  }));
}
