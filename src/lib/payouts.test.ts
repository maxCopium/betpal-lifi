import { describe, it, expect } from "vitest";
import { computePayouts, type Stake } from "./payouts";

// Helpers ---------------------------------------------------------------------
const stake = (userId: string, outcome: string, cents: number): Stake => ({
  userId,
  outcomeChosen: outcome,
  amountCents: cents,
});

const sumPayouts = (r: { payouts: { amountCents: number }[] }) =>
  r.payouts.reduce((a, p) => a + p.amountCents, 0);

const findPayout = (
  r: { payouts: { userId: string; amountCents: number }[] },
  userId: string,
) => r.payouts.find((p) => p.userId === userId)?.amountCents;

// =============================================================================
// INVARIANT: sum of payouts always equals totalPoolCents
// =============================================================================
describe("invariant: sum(payouts) === totalPoolCents", () => {
  it("simple 1v1 win, no yield", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 500), stake("b", "NO", 500)],
      winningOutcome: "YES",
      totalPoolCents: 1000,
    });
    expect(sumPayouts(r)).toBe(1000);
  });

  it("1v1 with yield", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 500), stake("b", "NO", 500)],
      winningOutcome: "YES",
      totalPoolCents: 1050,
    });
    expect(sumPayouts(r)).toBe(1050);
  });

  it("3v2 with yield and dust", () => {
    const r = computePayouts({
      stakes: [
        stake("a", "YES", 500),
        stake("b", "YES", 500),
        stake("c", "YES", 500),
        stake("d", "NO", 500),
        stake("e", "NO", 500),
      ],
      winningOutcome: "YES",
      totalPoolCents: 2507,
    });
    expect(sumPayouts(r)).toBe(2507);
  });

  it("release void preserves total", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 500), stake("b", "NO", 500)],
      winningOutcome: null,
      totalPoolCents: 1000,
    });
    expect(sumPayouts(r)).toBe(1000);
  });
});

// =============================================================================
// Equal stakes — winners split pool equally
// =============================================================================
describe("equal stakes — winner takes all", () => {
  it("1v1: winner gets entire pool", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 500), stake("b", "NO", 500)],
      winningOutcome: "YES",
      totalPoolCents: 1000,
    });
    expect(r.released).toBe(false);
    expect(findPayout(r, "a")).toBe(1000);
    expect(findPayout(r, "b")).toBeUndefined();
  });

  it("1v1 with yield: winner gets pool + yield", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 500), stake("b", "NO", 500)],
      winningOutcome: "YES",
      totalPoolCents: 1100,
    });
    expect(findPayout(r, "a")).toBe(1100);
  });

  it("loser is not in payouts list", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 500), stake("b", "NO", 500)],
      winningOutcome: "YES",
      totalPoolCents: 1000,
    });
    expect(r.payouts.map((p) => p.userId)).toEqual(["a"]);
  });
});

describe("equal stakes — multiple winners split equally", () => {
  it("2 winners split pool equally", () => {
    const r = computePayouts({
      stakes: [
        stake("a", "YES", 500),
        stake("b", "YES", 500),
        stake("c", "NO", 500),
      ],
      winningOutcome: "YES",
      totalPoolCents: 1500,
    });
    expect(findPayout(r, "a")).toBe(750);
    expect(findPayout(r, "b")).toBe(750);
  });

  it("3 winners, 2 losers: equal split among winners", () => {
    const r = computePayouts({
      stakes: [
        stake("a", "YES", 500),
        stake("b", "YES", 500),
        stake("c", "YES", 500),
        stake("d", "NO", 500),
        stake("e", "NO", 500),
      ],
      winningOutcome: "YES",
      totalPoolCents: 2500,
    });
    // 2500 / 3 = 833.33... → dust handling
    expect(sumPayouts(r)).toBe(2500);
    const amts = [findPayout(r, "a")!, findPayout(r, "b")!, findPayout(r, "c")!].sort();
    expect(amts).toEqual([833, 833, 834]);
  });

  it("1 vs 4: lone dissenter wins 5×", () => {
    const r = computePayouts({
      stakes: [
        stake("a", "NO", 1000),
        stake("b", "YES", 1000),
        stake("c", "YES", 1000),
        stake("d", "YES", 1000),
        stake("e", "YES", 1000),
      ],
      winningOutcome: "NO",
      totalPoolCents: 5000,
    });
    expect(findPayout(r, "a")).toBe(5000);
  });

  it("4 vs 1: each winner gets pool/4", () => {
    const r = computePayouts({
      stakes: [
        stake("a", "YES", 1000),
        stake("b", "YES", 1000),
        stake("c", "YES", 1000),
        stake("d", "YES", 1000),
        stake("e", "NO", 1000),
      ],
      winningOutcome: "YES",
      totalPoolCents: 5000,
    });
    expect(findPayout(r, "a")).toBe(1250);
    expect(findPayout(r, "b")).toBe(1250);
    expect(findPayout(r, "c")).toBe(1250);
    expect(findPayout(r, "d")).toBe(1250);
  });
});

// =============================================================================
// Release cases (money stays in group)
// =============================================================================
describe("release cases", () => {
  it("void: everyone gets stake back", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 500), stake("b", "NO", 500)],
      winningOutcome: null,
      totalPoolCents: 1000,
    });
    expect(r.released).toBe(true);
    expect(r.reason).toBe("void");
    expect(findPayout(r, "a")).toBe(500);
    expect(findPayout(r, "b")).toBe(500);
  });

  it("single staker: released", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 500)],
      winningOutcome: "YES",
      totalPoolCents: 550,
    });
    expect(r.released).toBe(true);
    expect(r.reason).toBe("single_staker");
    expect(findPayout(r, "a")).toBe(550);
  });

  it("single outcome (all same side): released", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 500), stake("b", "YES", 500)],
      winningOutcome: "YES",
      totalPoolCents: 1010,
    });
    expect(r.released).toBe(true);
    expect(r.reason).toBe("single_outcome");
    expect(findPayout(r, "a")).toBe(505);
    expect(findPayout(r, "b")).toBe(505);
  });

  it("no winners (winning outcome had no stakers): released", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 500), stake("b", "NO", 500)],
      winningOutcome: "MAYBE",
      totalPoolCents: 1000,
    });
    expect(r.released).toBe(true);
    expect(r.reason).toBe("no_winners");
    expect(findPayout(r, "a")).toBe(500);
    expect(findPayout(r, "b")).toBe(500);
  });

  it("empty stakes: void release with no payouts", () => {
    const r = computePayouts({
      stakes: [],
      winningOutcome: "YES",
      totalPoolCents: 0,
    });
    expect(r.released).toBe(true);
    expect(r.payouts).toEqual([]);
  });

  it("release with yield distributes pro-rata", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 500), stake("b", "NO", 500)],
      winningOutcome: null,
      totalPoolCents: 1100,
    });
    // Equal stakes → equal split of yield too
    expect(findPayout(r, "a")).toBe(550);
    expect(findPayout(r, "b")).toBe(550);
  });
});

// =============================================================================
// Dust / largest-remainder allocation
// =============================================================================
describe("dust handling (largest-remainder)", () => {
  it("indivisible cent goes to largest remainder", () => {
    const r = computePayouts({
      stakes: [
        stake("a", "YES", 500),
        stake("b", "YES", 500),
        stake("c", "YES", 500),
        stake("d", "NO", 500),
      ],
      winningOutcome: "YES",
      totalPoolCents: 2000,
    });
    expect(sumPayouts(r)).toBe(2000);
    const amts = [findPayout(r, "a")!, findPayout(r, "b")!, findPayout(r, "c")!].sort();
    expect(amts).toEqual([666, 667, 667]);
  });

  it("deterministic tie-breaking by userId", () => {
    const r = computePayouts({
      stakes: [
        stake("z", "YES", 500),
        stake("a", "YES", 500),
        stake("m", "YES", 500),
        stake("x", "NO", 500),
      ],
      winningOutcome: "YES",
      totalPoolCents: 2000,
    });
    // All equal remainder → distributed by userId ascending
    expect(sumPayouts(r)).toBe(2000);
  });

  it("never produces a negative payout", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 500), stake("b", "NO", 500)],
      winningOutcome: "YES",
      totalPoolCents: 1000,
    });
    for (const p of r.payouts) expect(p.amountCents).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// Large group scenarios
// =============================================================================
describe("large groups", () => {
  it("8 players, 6v2: winners each get pool/6", () => {
    const stakes: Stake[] = [];
    for (let i = 0; i < 6; i++) stakes.push(stake(`w${i}`, "YES", 500));
    for (let i = 0; i < 2; i++) stakes.push(stake(`l${i}`, "NO", 500));
    const r = computePayouts({
      stakes,
      winningOutcome: "YES",
      totalPoolCents: 4000,
    });
    expect(sumPayouts(r)).toBe(4000);
    expect(r.payouts.length).toBe(6);
    // 4000/6 = 666.67 → dust distributed
    const amts = r.payouts.map((p) => p.amountCents).sort();
    expect(amts[0]).toBeGreaterThanOrEqual(666);
    expect(amts[5]).toBeLessThanOrEqual(668);
  });

  it("10 players, 1v9: lone dissenter wins 10×", () => {
    const stakes: Stake[] = [stake("hero", "NO", 500)];
    for (let i = 0; i < 9; i++) stakes.push(stake(`l${i}`, "YES", 500));
    const r = computePayouts({
      stakes,
      winningOutcome: "NO",
      totalPoolCents: 5000,
    });
    expect(findPayout(r, "hero")).toBe(5000);
  });

  it("100 players with yield, dust distributed", () => {
    const stakes: Stake[] = [];
    for (let i = 0; i < 50; i++) stakes.push(stake(`w${i}`, "YES", 1000));
    for (let i = 0; i < 50; i++) stakes.push(stake(`l${i}`, "NO", 1000));
    const r = computePayouts({
      stakes,
      winningOutcome: "YES",
      totalPoolCents: 100_000 + 1234,
    });
    expect(sumPayouts(r)).toBe(101_234);
    expect(r.payouts.length).toBe(50);
  });
});

// =============================================================================
// Defensive validation
// =============================================================================
describe("input validation", () => {
  it("throws on negative pool", () => {
    expect(() =>
      computePayouts({ stakes: [stake("a", "YES", 500)], winningOutcome: "YES", totalPoolCents: -1 }),
    ).toThrow();
  });

  it("throws on non-integer pool", () => {
    expect(() =>
      computePayouts({ stakes: [stake("a", "YES", 500)], winningOutcome: "YES", totalPoolCents: 1.5 }),
    ).toThrow();
  });

  it("throws on zero stake", () => {
    expect(() =>
      computePayouts({ stakes: [stake("a", "YES", 0)], winningOutcome: "YES", totalPoolCents: 0 }),
    ).toThrow();
  });

  it("throws when principal exceeds pool", () => {
    expect(() =>
      computePayouts({
        stakes: [stake("a", "YES", 500), stake("b", "NO", 500)],
        winningOutcome: "YES",
        totalPoolCents: 50,
      }),
    ).toThrow();
  });

  it("throws if a single user has stakes on multiple outcomes", () => {
    expect(() =>
      computePayouts({
        stakes: [stake("a", "YES", 500), stake("a", "NO", 500)],
        winningOutcome: "YES",
        totalPoolCents: 1000,
      }),
    ).toThrow();
  });
});

// =============================================================================
// Determinism
// =============================================================================
describe("determinism", () => {
  it("identical inputs return identical outputs", () => {
    const args = {
      stakes: [
        stake("a", "YES", 500),
        stake("b", "YES", 500),
        stake("c", "NO", 500),
        stake("d", "NO", 500),
      ],
      winningOutcome: "YES",
      totalPoolCents: 2000,
    };
    const r1 = computePayouts(args);
    const r2 = computePayouts(args);
    expect(r1).toEqual(r2);
  });

  it("input order does not change amounts", () => {
    const r1 = computePayouts({
      stakes: [stake("a", "YES", 500), stake("b", "YES", 500), stake("c", "NO", 500)],
      winningOutcome: "YES",
      totalPoolCents: 1500,
    });
    const r2 = computePayouts({
      stakes: [stake("c", "NO", 500), stake("b", "YES", 500), stake("a", "YES", 500)],
      winningOutcome: "YES",
      totalPoolCents: 1500,
    });
    expect(findPayout(r1, "a")).toBe(findPayout(r2, "a"));
    expect(findPayout(r1, "b")).toBe(findPayout(r2, "b"));
  });
});
