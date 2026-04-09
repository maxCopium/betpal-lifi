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
      stakes: [stake("a", "YES", 1000), stake("b", "NO", 1000)],
      winningOutcome: "YES",
      totalPoolCents: 2000,
    });
    expect(sumPayouts(r)).toBe(2000);
  });

  it("1v1 with yield", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 1000), stake("b", "NO", 1000)],
      winningOutcome: "YES",
      totalPoolCents: 2050,
    });
    expect(sumPayouts(r)).toBe(2050);
  });

  it("3v2 with yield and dust", () => {
    const r = computePayouts({
      stakes: [
        stake("a", "YES", 333),
        stake("b", "YES", 333),
        stake("c", "YES", 333),
        stake("d", "NO", 500),
        stake("e", "NO", 500),
      ],
      winningOutcome: "YES",
      totalPoolCents: 2007, // 1999 principal + 8 yield
    });
    expect(sumPayouts(r)).toBe(2007);
  });

  it("refund void preserves total", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 1234), stake("b", "NO", 5678)],
      winningOutcome: null,
      totalPoolCents: 6912,
    });
    expect(sumPayouts(r)).toBe(6912);
  });

  it("refund with yield distributes whole pool", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 1000), stake("b", "NO", 3000)],
      winningOutcome: null,
      totalPoolCents: 4100, // 100 yield
    });
    expect(sumPayouts(r)).toBe(4100);
  });
});

// =============================================================================
// 1v1 binary mechanics
// =============================================================================
describe("1v1 binary bets", () => {
  it("equal stakes, no yield: winner doubles", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 1000), stake("b", "NO", 1000)],
      winningOutcome: "YES",
      totalPoolCents: 2000,
    });
    expect(r.refunded).toBe(false);
    expect(findPayout(r, "a")).toBe(2000);
    expect(findPayout(r, "b")).toBeUndefined();
  });

  it("unequal stakes, no yield: winner takes all", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 500), stake("b", "NO", 1500)],
      winningOutcome: "NO",
      totalPoolCents: 2000,
    });
    expect(findPayout(r, "b")).toBe(2000);
  });

  it("yield goes to the winner", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 1000), stake("b", "NO", 1000)],
      winningOutcome: "YES",
      totalPoolCents: 2200,
    });
    expect(findPayout(r, "a")).toBe(2200);
  });

  it("loser is not in payouts list", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 1000), stake("b", "NO", 1000)],
      winningOutcome: "YES",
      totalPoolCents: 2000,
    });
    expect(r.payouts.map((p) => p.userId)).toEqual(["a"]);
  });
});

// =============================================================================
// Multi-bettor pari-mutuel
// =============================================================================
describe("multi-bettor pari-mutuel", () => {
  it("2 winners share losers' pool proportionally", () => {
    const r = computePayouts({
      stakes: [
        stake("a", "YES", 1000),
        stake("b", "YES", 3000),
        stake("c", "NO", 4000),
      ],
      winningOutcome: "YES",
      totalPoolCents: 8000,
    });
    // a:b winning weight = 1:3, total pool 8000
    // a should get 2000, b should get 6000
    expect(findPayout(r, "a")).toBe(2000);
    expect(findPayout(r, "b")).toBe(6000);
  });

  it("3 winners with yield", () => {
    const r = computePayouts({
      stakes: [
        stake("a", "YES", 100),
        stake("b", "YES", 200),
        stake("c", "YES", 300),
        stake("d", "NO", 600),
      ],
      winningOutcome: "YES",
      totalPoolCents: 1260, // 1200 principal + 60 yield
    });
    // weights 100/200/300 of 1260
    expect(findPayout(r, "a")).toBe(210);
    expect(findPayout(r, "b")).toBe(420);
    expect(findPayout(r, "c")).toBe(630);
  });

  it("many winners, many losers", () => {
    const r = computePayouts({
      stakes: [
        stake("a", "YES", 100),
        stake("b", "YES", 100),
        stake("c", "YES", 100),
        stake("d", "YES", 100),
        stake("e", "NO", 200),
        stake("f", "NO", 200),
      ],
      winningOutcome: "YES",
      totalPoolCents: 800,
    });
    expect(findPayout(r, "a")).toBe(200);
    expect(findPayout(r, "b")).toBe(200);
    expect(findPayout(r, "c")).toBe(200);
    expect(findPayout(r, "d")).toBe(200);
  });
});

// =============================================================================
// Refund edge cases
// =============================================================================
describe("refunds", () => {
  it("void: returns principal to all stakers", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 1000), stake("b", "NO", 2000)],
      winningOutcome: null,
      totalPoolCents: 3000,
    });
    expect(r.refunded).toBe(true);
    expect(r.reason).toBe("void");
    expect(findPayout(r, "a")).toBe(1000);
    expect(findPayout(r, "b")).toBe(2000);
  });

  it("void: yield distributed pro-rata", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 1000), stake("b", "NO", 3000)],
      winningOutcome: null,
      totalPoolCents: 4400, // 400 yield
    });
    // weights 1:3 of 4400 = 1100, 3300
    expect(findPayout(r, "a")).toBe(1100);
    expect(findPayout(r, "b")).toBe(3300);
  });

  it("single staker: refunded", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 1000)],
      winningOutcome: "YES",
      totalPoolCents: 1050,
    });
    expect(r.refunded).toBe(true);
    expect(r.reason).toBe("single_staker");
    expect(findPayout(r, "a")).toBe(1050);
  });

  it("single outcome (everyone on same side): refunded", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 500), stake("b", "YES", 500)],
      winningOutcome: "YES",
      totalPoolCents: 1010,
    });
    expect(r.refunded).toBe(true);
    expect(r.reason).toBe("single_outcome");
    // 1010 split 1:1 → 505 each
    expect(findPayout(r, "a")).toBe(505);
    expect(findPayout(r, "b")).toBe(505);
  });

  it("no winners (winning outcome had no stakers): refunded", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 1000), stake("b", "NO", 1000)],
      winningOutcome: "MAYBE",
      totalPoolCents: 2000,
    });
    expect(r.refunded).toBe(true);
    expect(r.reason).toBe("no_winners");
    expect(findPayout(r, "a")).toBe(1000);
    expect(findPayout(r, "b")).toBe(1000);
  });

  it("empty stakes: void refund with no payouts", () => {
    const r = computePayouts({
      stakes: [],
      winningOutcome: "YES",
      totalPoolCents: 0,
    });
    expect(r.refunded).toBe(true);
    expect(r.payouts).toEqual([]);
  });
});

// =============================================================================
// Dust / largest-remainder allocation
// =============================================================================
describe("dust handling (largest-remainder)", () => {
  it("indivisible cent goes to largest remainder", () => {
    // 3 winners equal stake, pool 100 → 33,33,34
    const r = computePayouts({
      stakes: [
        stake("a", "YES", 10),
        stake("b", "YES", 10),
        stake("c", "YES", 10),
        stake("d", "NO", 10),
      ],
      winningOutcome: "YES",
      totalPoolCents: 100,
    });
    expect(sumPayouts(r)).toBe(100);
    const amts = [
      findPayout(r, "a")!,
      findPayout(r, "b")!,
      findPayout(r, "c")!,
    ].sort();
    expect(amts).toEqual([33, 33, 34]);
  });

  it("two leftover cents distributed to two largest remainders", () => {
    const r = computePayouts({
      stakes: [
        stake("a", "YES", 1),
        stake("b", "YES", 1),
        stake("c", "YES", 1),
        stake("d", "NO", 1),
      ],
      winningOutcome: "YES",
      totalPoolCents: 11,
    });
    // floor(11/3)=3 each, remainders all equal → leftover 2 → first two by userId
    expect(sumPayouts(r)).toBe(11);
    expect(findPayout(r, "a")).toBe(4);
    expect(findPayout(r, "b")).toBe(4);
    expect(findPayout(r, "c")).toBe(3);
  });

  it("deterministic tie-breaking by userId", () => {
    const r1 = computePayouts({
      stakes: [
        stake("z", "YES", 1),
        stake("a", "YES", 1),
        stake("m", "YES", 1),
        stake("x", "NO", 1),
      ],
      winningOutcome: "YES",
      totalPoolCents: 10,
    });
    // floor(10/3)=3 each, leftover 1 → goes to "a" (smallest userId)
    expect(findPayout(r1, "a")).toBe(4);
    expect(findPayout(r1, "m")).toBe(3);
    expect(findPayout(r1, "z")).toBe(3);
  });

  it("dust in refund branch too", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 1), stake("b", "NO", 1), stake("c", "YES", 1)],
      winningOutcome: null,
      totalPoolCents: 10,
    });
    expect(sumPayouts(r)).toBe(10);
  });

  it("never produces a negative payout", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 7), stake("b", "NO", 3)],
      winningOutcome: "YES",
      totalPoolCents: 10,
    });
    for (const p of r.payouts) expect(p.amountCents).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// Yield distribution
// =============================================================================
describe("yield handling", () => {
  it("zero yield: winner gets exactly principal pool", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 100), stake("b", "NO", 100)],
      winningOutcome: "YES",
      totalPoolCents: 200,
    });
    expect(findPayout(r, "a")).toBe(200);
  });

  it("positive yield: scales winner payout above principal", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 100), stake("b", "NO", 100)],
      winningOutcome: "YES",
      totalPoolCents: 220,
    });
    expect(findPayout(r, "a")).toBe(220);
  });

  it("yield-only refund (somehow no losers ever existed)", () => {
    const r = computePayouts({
      stakes: [stake("a", "YES", 1000)],
      winningOutcome: "YES",
      totalPoolCents: 1100,
    });
    expect(r.refunded).toBe(true);
    expect(findPayout(r, "a")).toBe(1100);
  });
});

// =============================================================================
// Defensive validation
// =============================================================================
describe("input validation", () => {
  it("throws on negative pool", () => {
    expect(() =>
      computePayouts({
        stakes: [stake("a", "YES", 1)],
        winningOutcome: "YES",
        totalPoolCents: -1,
      }),
    ).toThrow();
  });

  it("throws on non-integer pool", () => {
    expect(() =>
      computePayouts({
        stakes: [stake("a", "YES", 1)],
        winningOutcome: "YES",
        totalPoolCents: 1.5,
      }),
    ).toThrow();
  });

  it("throws on zero stake", () => {
    expect(() =>
      computePayouts({
        stakes: [stake("a", "YES", 0)],
        winningOutcome: "YES",
        totalPoolCents: 0,
      }),
    ).toThrow();
  });

  it("throws on negative stake", () => {
    expect(() =>
      computePayouts({
        stakes: [stake("a", "YES", -1)],
        winningOutcome: "YES",
        totalPoolCents: 0,
      }),
    ).toThrow();
  });

  it("throws when principal exceeds pool", () => {
    expect(() =>
      computePayouts({
        stakes: [stake("a", "YES", 100), stake("b", "NO", 100)],
        winningOutcome: "YES",
        totalPoolCents: 50,
      }),
    ).toThrow();
  });

  it("throws if a single user has stakes on multiple outcomes", () => {
    expect(() =>
      computePayouts({
        stakes: [stake("a", "YES", 100), stake("a", "NO", 100)],
        winningOutcome: "YES",
        totalPoolCents: 200,
      }),
    ).toThrow();
  });
});

// =============================================================================
// Determinism: same input → same output
// =============================================================================
describe("determinism", () => {
  it("identical inputs return identical outputs across runs", () => {
    const args = {
      stakes: [
        stake("a", "YES", 137),
        stake("b", "YES", 241),
        stake("c", "NO", 379),
        stake("d", "NO", 500),
      ],
      winningOutcome: "YES",
      totalPoolCents: 1300,
    };
    const r1 = computePayouts(args);
    const r2 = computePayouts(args);
    expect(r1).toEqual(r2);
  });

  it("input order does not change winner amounts", () => {
    const r1 = computePayouts({
      stakes: [
        stake("a", "YES", 100),
        stake("b", "YES", 200),
        stake("c", "NO", 300),
      ],
      winningOutcome: "YES",
      totalPoolCents: 600,
    });
    const r2 = computePayouts({
      stakes: [
        stake("c", "NO", 300),
        stake("b", "YES", 200),
        stake("a", "YES", 100),
      ],
      winningOutcome: "YES",
      totalPoolCents: 600,
    });
    expect(findPayout(r1, "a")).toBe(findPayout(r2, "a"));
    expect(findPayout(r1, "b")).toBe(findPayout(r2, "b"));
  });
});

// =============================================================================
// Property-style spot checks at large scale
// =============================================================================
describe("scale", () => {
  it("100 winners, 100 losers, large pool", () => {
    const stakes: Stake[] = [];
    for (let i = 0; i < 100; i++) stakes.push(stake(`w${i}`, "YES", 1000));
    for (let i = 0; i < 100; i++) stakes.push(stake(`l${i}`, "NO", 1000));
    const r = computePayouts({
      stakes,
      winningOutcome: "YES",
      totalPoolCents: 200_000 + 1234, // some yield
    });
    expect(sumPayouts(r)).toBe(201_234);
    expect(r.payouts.length).toBe(100);
  });

  it("uneven weights, large prime-ish pool, dust distributed", () => {
    const stakes: Stake[] = [
      stake("a", "YES", 7),
      stake("b", "YES", 11),
      stake("c", "YES", 13),
      stake("d", "NO", 100),
    ];
    const r = computePayouts({
      stakes,
      winningOutcome: "YES",
      totalPoolCents: 131,
    });
    expect(sumPayouts(r)).toBe(131);
  });
});
