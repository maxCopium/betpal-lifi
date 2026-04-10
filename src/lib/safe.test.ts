import { describe, it, expect, beforeAll } from "vitest";

// Safe.ts reads APP_RESOLVER_ADDRESS via env.resolverAddress() at call time, so
// we set the minimum env vars before importing the module under test. The other
// required vars are only touched by other functions, so they can stay unset.
const RESOLVER = "0x000000000000000000000000000000000000dEaD" as const;
process.env.APP_RESOLVER_ADDRESS = RESOLVER;

// Dynamic import so the env var is set first.
let buildSafeConfig: typeof import("./safe").buildSafeConfig;
let assertSafeInvariants: typeof import("./safe").assertSafeInvariants;

beforeAll(async () => {
  const mod = await import("./safe");
  buildSafeConfig = mod.buildSafeConfig;
  assertSafeInvariants = mod.assertSafeInvariants;
});

const addr = (n: number): `0x${string}` =>
  ("0x" + n.toString(16).padStart(40, "0")) as `0x${string}`;

describe("buildSafeConfig — owner set", () => {
  it("appends the resolver to the member list", () => {
    const cfg = buildSafeConfig({
      groupId: "g1",
      memberAddresses: [addr(1), addr(2)],
    });
    expect(cfg.owners).toHaveLength(3);
    expect(cfg.owners[cfg.owners.length - 1].toLowerCase()).toBe(
      RESOLVER.toLowerCase(),
    );
  });

  it("dedupes the resolver if it is already in the member list", () => {
    const cfg = buildSafeConfig({
      groupId: "g1",
      memberAddresses: [addr(1), RESOLVER, addr(2)],
    });
    expect(cfg.owners).toHaveLength(3);
    const lc = cfg.owners.map((o) => o.toLowerCase());
    expect(new Set(lc).size).toBe(3);
    expect(lc).toContain(RESOLVER.toLowerCase());
  });

  it("dedupes duplicate member addresses (case-insensitive)", () => {
    const upper = addr(1).toUpperCase().replace("0X", "0x") as `0x${string}`;
    const cfg = buildSafeConfig({
      groupId: "g1",
      memberAddresses: [addr(1), upper, addr(2)],
    });
    expect(cfg.owners).toHaveLength(3); // 2 unique members + resolver
  });

  it("rejects an empty member list", () => {
    expect(() =>
      buildSafeConfig({ groupId: "g1", memberAddresses: [] }),
    ).toThrow(/zero members/);
  });
});

describe("buildSafeConfig — threshold scaling", () => {
  // Members → expected threshold (resolver always +1, threshold = max(2, floor(N/2)+1))
  const cases: Array<[number, number]> = [
    [1, 2],
    [2, 2],
    [3, 2],
    [4, 3],
    [5, 3],
    [6, 4],
    [7, 4],
    [10, 6],
  ];
  for (const [memberCount, expectedThreshold] of cases) {
    it(`memberCount=${memberCount} → threshold=${expectedThreshold}`, () => {
      const members = Array.from({ length: memberCount }, (_, i) => addr(i + 1));
      const cfg = buildSafeConfig({ groupId: "g", memberAddresses: members });
      expect(cfg.threshold).toBe(expectedThreshold);
      // Resolver alone (1 sig) must never reach threshold.
      expect(cfg.threshold).toBeGreaterThanOrEqual(2);
    });
  }
});

describe("buildSafeConfig — saltNonce determinism", () => {
  it("same groupId + members produces the same saltNonce", () => {
    const a = buildSafeConfig({
      groupId: "abc-123",
      memberAddresses: [addr(1), addr(2)],
    });
    const b = buildSafeConfig({
      groupId: "abc-123",
      memberAddresses: [addr(9), addr(8)], // saltNonce derives from groupId only
    });
    expect(a.saltNonce).toBe(b.saltNonce);
  });

  it("different groupId produces a different saltNonce", () => {
    const a = buildSafeConfig({
      groupId: "abc-123",
      memberAddresses: [addr(1), addr(2)],
    });
    const b = buildSafeConfig({
      groupId: "abc-124",
      memberAddresses: [addr(1), addr(2)],
    });
    expect(a.saltNonce).not.toBe(b.saltNonce);
  });

  it("saltNonce is a decimal string of a 256-bit value", () => {
    const cfg = buildSafeConfig({
      groupId: "abc-123",
      memberAddresses: [addr(1), addr(2)],
    });
    expect(cfg.saltNonce).toMatch(/^\d+$/);
    expect(BigInt(cfg.saltNonce) > BigInt(0)).toBe(true);
  });
});

describe("assertSafeInvariants", () => {
  it("accepts a valid config", () => {
    expect(() =>
      assertSafeInvariants({
        owners: [addr(1), addr(2), RESOLVER],
        threshold: 2,
      }),
    ).not.toThrow();
  });

  it("rejects threshold < 2", () => {
    expect(() =>
      assertSafeInvariants({
        owners: [addr(1), addr(2), RESOLVER],
        threshold: 1,
      }),
    ).toThrow(/threshold/i);
  });

  it("rejects owners that don't include the resolver", () => {
    expect(() =>
      assertSafeInvariants({
        owners: [addr(1), addr(2), addr(3)],
        threshold: 2,
      }),
    ).toThrow(/resolver/i);
  });

  it("rejects owners with no members (only resolver)", () => {
    expect(() =>
      assertSafeInvariants({
        owners: [RESOLVER],
        threshold: 2,
      }),
    ).toThrow(/at least 1 member/i);
  });

  it("structurally rejects threshold=1 (app key alone meets threshold)", () => {
    expect(() =>
      assertSafeInvariants({
        owners: [addr(1), RESOLVER],
        threshold: 1,
      }),
    ).toThrow(); // caught by either "threshold ≥ 2" or "app key alone"
  });
});
