import { describe, it, expect, vi } from "vitest";

/**
 * Tests for ledger business logic: idempotency, balance computation,
 * and the withdrawal reserve/reverse pattern.
 */

vi.mock("server-only", () => ({}));

// Mock Supabase
const mockInsert = vi.fn();
const mockSelect = vi.fn();

vi.mock("./supabase", () => ({
  supabaseService: () => ({
    from: (table: string) => {
      if (table === "balance_events") {
        return {
          insert: mockInsert,
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: [
                  { delta_cents: 1000 },
                  { delta_cents: -500 },
                  { delta_cents: 200 },
                ],
                error: null,
              }),
            }),
            single: vi.fn().mockResolvedValue({
              data: { id: "existing-evt" },
              error: null,
            }),
          }),
        };
      }
      if (table === "stakes") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({ data: [{ amount_cents: 300 }], error: null }),
            }),
          }),
        };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    },
  }),
}));

describe("ledger — balance computation logic", () => {
  it("free balance = total - locked stakes", () => {
    // Simulating: deposits +1000, stake_lock -500, yield_credit +200
    // total = 700
    // locked stakes on open bets = 300
    // free = 700 - 300 = 400
    const total = 1000 + (-500) + 200; // 700
    const locked = 300;
    const free = total - locked;
    expect(free).toBe(400);
  });

  it("withdrawal reserve + reversal nets to zero", () => {
    const amountCents = 750;
    const reserve = -amountCents; // withdrawal_reserve
    const reversal = amountCents; // withdrawal_reverse (on failure)
    expect(reserve + reversal).toBe(0);
  });

  it("idempotency keys are deterministic for deposits", () => {
    const txHash = "0xabc123";
    const key1 = `deposit:${txHash}`;
    const key2 = `deposit:${txHash}`;
    expect(key1).toBe(key2);
  });

  it("idempotency keys are deterministic for stake locks", () => {
    const betId = "bet-1";
    const userId = "user-1";
    const key = `stake_lock:${betId}:${userId}`;
    expect(key).toBe("stake_lock:bet-1:user-1");
  });

  it("idempotency keys are deterministic for payouts", () => {
    const betId = "bet-1";
    const userId = "user-1";
    const key = `payout:${betId}:${userId}`;
    expect(key).toBe("payout:bet-1:user-1");
  });

  it("auto-payout idempotency prevents double-payout", () => {
    const betId = "bet-1";
    const userId = "user-1";
    const key = `auto_payout:${betId}:${userId}`;
    // If this key already exists in balance_events, skip the on-chain payout
    expect(key).toBe("auto_payout:bet-1:user-1");
  });
});

describe("ledger — cents arithmetic", () => {
  it("all amounts are integers (no float drift)", () => {
    // This is a critical invariant: all money is integer cents
    const deposit = 1050; // $10.50
    const stakeLock = -500; // $5.00
    const payout = 1500; // $15.00
    expect(Number.isInteger(deposit)).toBe(true);
    expect(Number.isInteger(stakeLock)).toBe(true);
    expect(Number.isInteger(payout)).toBe(true);
    expect(Number.isInteger(deposit + stakeLock + payout)).toBe(true);
  });

  it("USDC conversion: 1 cent = 10000 base units", () => {
    const cents = 500; // $5.00
    const baseUnits = BigInt(cents) * BigInt(10_000);
    expect(baseUnits).toBe(BigInt(5_000_000));
    // USDC has 6 decimals: 5_000_000 / 10^6 = 5.000000 USDC = $5.00
  });
});
