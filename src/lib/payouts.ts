/**
 * Equal-stakes pari-mutuel payout calculation for BetPal.
 *
 * Model: Every participant stakes the same fixed amount. Winners split
 * the entire pool equally. The "odds" come from the group's own split
 * (e.g. 4 vs 1 → the lone dissenter wins 5×). Polymarket is the oracle
 * only — it determines WHO wins, never HOW MUCH.
 *
 * INVARIANTS (must hold for every call):
 *   1. All amounts are integer cents. No floats anywhere in this module.
 *   2. sum(result.payouts.amountCents) === totalPoolCents, exactly.
 *   3. No payout is negative.
 *   4. Every input staker appears exactly once in the output.
 *   5. Function is pure: no I/O, no Date.now(), no randomness.
 *
 * Release cases (stake locks released, money stays in group):
 *   - winningOutcome === null  (void / unresolvable)
 *   - no stake matches the winning outcome (0 winners)
 *   - only one distinct staker on the bet
 *   - only one distinct outcome was staked (no losers — bet shouldn't have started)
 *
 * Win case:
 *   - Winners split the entire pool equally (since all stakes are the same).
 *   - Yield (totalPoolCents - sum(stakes)) is included in the pool.
 *
 * Dust handling:
 *   - We use the largest-remainder method so the sum is exact and any leftover
 *     cent goes deterministically, breaking ties by userId (lexicographic).
 */

export type Stake = {
  userId: string;
  outcomeChosen: string;
  amountCents: number;
};

export type Payout = {
  userId: string;
  amountCents: number;
};

export type PayoutResult = {
  payouts: Payout[];
  /** If true, stake locks should be released (money stays in group). */
  released: boolean;
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

  // Aggregate stakes per user (defensive — one-stake-per-user is enforced at DB level).
  type Agg = { userId: string; outcome: string; amountCents: number };
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
    return { payouts: [], released: true, reason: "void" };
  }

  // -------- release branches (stake locks released, money stays in group) ----
  const distinctOutcomes = new Set(aggregated.map((a) => a.outcome));
  const isVoid = winningOutcome === null;
  const isSingleStaker = aggregated.length === 1;
  const isSingleOutcome = distinctOutcomes.size === 1;
  const winners = isVoid
    ? []
    : aggregated.filter((a) => a.outcome === winningOutcome);
  const isNoWinners = !isVoid && winners.length === 0;

  if (isVoid || isSingleStaker || isSingleOutcome || isNoWinners) {
    const reason: PayoutResult["reason"] = isVoid
      ? "void"
      : isSingleStaker
        ? "single_staker"
        : isSingleOutcome
          ? "single_outcome"
          : "no_winners";

    // Release: each user gets their exact stake back as free balance.
    // Yield (if any) is distributed pro-rata by principal.
    const allocations = allocatePoolByWeights(
      totalPoolCents,
      aggregated.map((a) => ({ userId: a.userId, weight: a.amountCents })),
    );
    return { payouts: allocations, released: true, reason };
  }

  // -------- normal settlement ------------------------------------------------
  // Winners split the entire pool equally (equal stakes model).
  // With equal stakes, weight = amountCents is the same for all winners,
  // so this naturally produces pool / num_winners per winner.
  // If stakes happen to differ (legacy data), it still works proportionally.
  const allocations = allocatePoolByWeights(
    totalPoolCents,
    winners.map((w) => ({ userId: w.userId, weight: w.amountCents })),
  );

  return {
    payouts: allocations,
    released: false,
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

  type Row = { userId: string; weight: number; floor: number; remainder: bigint };
  const rows: Row[] = recipients.map((r) => {
    const numer = BigInt(pool) * BigInt(r.weight);
    const denom = BigInt(totalWeight);
    const floor = Number(numer / denom);
    const remainder = numer - BigInt(floor) * denom;
    return { userId: r.userId, weight: r.weight, floor, remainder };
  });

  let allocated = rows.reduce((acc, r) => acc + r.floor, 0);
  let leftover = pool - allocated;

  const sorted = [...rows].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.userId < b.userId ? -1 : 1;
  });

  for (let i = 0; leftover > 0 && i < sorted.length; i++) {
    sorted[i].floor += 1;
    leftover -= 1;
  }

  const byUser = new Map(sorted.map((r) => [r.userId, r.floor]));
  return rows.map((r) => ({
    userId: r.userId,
    amountCents: byUser.get(r.userId)!,
  }));
}
