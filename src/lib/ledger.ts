import "server-only";
import { supabaseService } from "./supabase";

/**
 * BetPal off-chain ledger.
 *
 * Source of truth is on-chain (the group's vault balance). The ledger is a
 * fast projection used for UX and bet attribution; an hourly reconciliation
 * job compares ledger sums against vault balances and alerts on drift.
 *
 * Mitigation #1 (append-only): every state change is a *new row* in
 * `balance_events` with a signed `delta_cents`. We never UPDATE or DELETE
 * existing events. The current balance is `sum(delta_cents)`.
 *
 * Mitigation #7 (idempotency): every event has an `idempotency_key`. The
 * unique constraint on the key makes retries safe.
 */

export type AddBalanceEventInput = {
  groupId: string;
  userId: string;
  deltaCents: number;
  reason:
    | "deposit"
    | "stake_lock"
    | "stake_refund"
    | "payout"
    | "yield_credit"
    | "reconciliation"
    | "adjustment";
  betId?: string;
  txHash?: string;
  /**
   * Stable, deterministic key. Examples:
   *   - "deposit:<txHash>"
   *   - "stake_lock:<betId>:<userId>"
   *   - "payout:<betId>:<userId>"
   * Re-running the same op MUST produce the same key.
   */
  idempotencyKey: string;
};

export type BalanceEventRow = {
  id: string;
  group_id: string;
  user_id: string;
  delta_cents: number;
  reason: string;
  bet_id: string | null;
  tx_hash: string | null;
  idempotency_key: string;
  created_at: string;
};

/**
 * Insert a balance event. Idempotent: if the key already exists, returns the
 * existing row instead of throwing.
 */
export async function addBalanceEvent(
  input: AddBalanceEventInput,
): Promise<BalanceEventRow> {
  if (!Number.isInteger(input.deltaCents)) {
    throw new Error("deltaCents must be an integer");
  }
  // Guard against overdraw: if this is a debit, verify the user's total
  // balance won't go negative. Skip for system-level adjustments that are
  // part of atomic reserve/reverse pairs (withdrawals, auto-payouts).
  if (input.deltaCents < 0 && input.reason !== "adjustment") {
    const currentBalance = await getUserGroupBalanceCents(input.groupId, input.userId);
    if (currentBalance + input.deltaCents < 0) {
      throw new Error(
        `overdraw prevented: user has ${currentBalance} cents, debit of ${input.deltaCents} would go negative ` +
        `(key: ${input.idempotencyKey})`,
      );
    }
  }
  const sb = supabaseService();
  const { data, error } = await sb
    .from("balance_events")
    .insert({
      group_id: input.groupId,
      user_id: input.userId,
      delta_cents: input.deltaCents,
      reason: input.reason,
      bet_id: input.betId ?? null,
      tx_hash: input.txHash ?? null,
      idempotency_key: input.idempotencyKey,
    })
    .select("*")
    .single();

  if (error) {
    // Unique-violation on idempotency_key → fetch and return the existing row.
    if (error.code === "23505") {
      const { data: existing, error: fetchErr } = await sb
        .from("balance_events")
        .select("*")
        .eq("idempotency_key", input.idempotencyKey)
        .single();
      if (fetchErr || !existing) {
        throw new Error(
          `idempotent fetch failed: ${fetchErr?.message ?? "unknown"}`,
        );
      }
      return existing as BalanceEventRow;
    }
    throw error;
  }
  return data as BalanceEventRow;
}

/** Sum of a single user's events in a group (in cents). */
export async function getUserGroupBalanceCents(
  groupId: string,
  userId: string,
): Promise<number> {
  const sb = supabaseService();
  const { data, error } = await sb
    .from("balance_events")
    .select("delta_cents")
    .eq("group_id", groupId)
    .eq("user_id", userId);
  if (error) throw error;
  return (data ?? []).reduce(
    (acc, r: { delta_cents: number }) => acc + Number(r.delta_cents),
    0,
  );
}

/** Sum of all events in a group (in cents). Should equal the vault balance. */
export async function getGroupTotalCents(groupId: string): Promise<number> {
  const sb = supabaseService();
  const { data, error } = await sb
    .from("balance_events")
    .select("delta_cents")
    .eq("group_id", groupId);
  if (error) throw error;
  return (data ?? []).reduce(
    (acc, r: { delta_cents: number }) => acc + Number(r.delta_cents),
    0,
  );
}

/**
 * Free balance = total - (locked stakes on open/locked/resolving bets).
 * Used to validate stake placement before locking funds.
 */
export async function getUserFreeBalanceCents(
  groupId: string,
  userId: string,
): Promise<number> {
  const sb = supabaseService();
  const total = await getUserGroupBalanceCents(groupId, userId);
  // Sum of stakes on bets that haven't settled yet:
  const { data, error } = await sb
    .from("stakes")
    .select("amount_cents, bet:bets!inner(group_id, status)")
    .eq("user_id", userId)
    .eq("bet.group_id", groupId)
    .in("bet.status", ["open", "locked", "resolving"]);
  if (error) throw error;
  const locked = (data ?? []).reduce(
    (acc, r: { amount_cents: number }) => acc + Number(r.amount_cents),
    0,
  );
  return total - locked;
}
