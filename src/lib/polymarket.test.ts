import { describe, it, expect } from "vitest";
import { isMarketSettleable, type PolymarketMarket } from "./polymarket";

// Helper to build a market with sensible defaults; tests override what they care about.
function mkt(overrides: Partial<PolymarketMarket> = {}): PolymarketMarket {
  return {
    id: "1",
    question: "Will X happen?",
    closed: true,
    endDate: "2025-01-01T00:00:00Z",
    outcomes: ["Yes", "No"],
    outcomePrices: ["1", "0"],
    ...overrides,
  } as PolymarketMarket;
}

// A "now" comfortably past the dispute buffer for the default endDate.
const NOW_PAST = new Date("2025-01-02T00:00:00Z");

describe("isMarketSettleable", () => {
  it("settles when closed, past buffer, with a 1.0 winning price", () => {
    const r = isMarketSettleable(mkt(), NOW_PAST);
    expect(r.settleable).toBe(true);
    expect(r.winningOutcome).toBe("Yes");
  });

  it("rejects markets that are not closed", () => {
    const r = isMarketSettleable(mkt({ closed: false }), NOW_PAST);
    expect(r.settleable).toBe(false);
    expect(r.reason).toMatch(/not closed/);
  });

  it("rejects within 2-hour dispute buffer", () => {
    const justClosed = new Date("2025-01-01T01:30:00Z"); // +1.5h
    const r = isMarketSettleable(mkt(), justClosed);
    expect(r.settleable).toBe(false);
    expect(r.reason).toMatch(/buffer/);
  });

  it("allows just past the 2-hour buffer", () => {
    const justPast = new Date("2025-01-01T02:00:01Z");
    const r = isMarketSettleable(mkt(), justPast);
    expect(r.settleable).toBe(true);
  });

  it("rejects when no outcome price reaches 0.99", () => {
    const r = isMarketSettleable(
      mkt({ outcomePrices: ["0.6", "0.4"] }),
      NOW_PAST,
    );
    expect(r.settleable).toBe(false);
    expect(r.reason).toMatch(/decisive/);
  });

  it("accepts a 0.99 winning price (boundary)", () => {
    const r = isMarketSettleable(
      mkt({ outcomePrices: ["0.99", "0.01"] }),
      NOW_PAST,
    );
    expect(r.settleable).toBe(true);
    expect(r.winningOutcome).toBe("Yes");
  });

  it("parses JSON-string-encoded outcomes and prices", () => {
    const r = isMarketSettleable(
      mkt({
        outcomes: '["Yes","No"]',
        outcomePrices: '["0","1"]',
      }),
      NOW_PAST,
    );
    expect(r.settleable).toBe(true);
    expect(r.winningOutcome).toBe("No");
  });

  it("rejects when outcomes / prices are missing", () => {
    const r = isMarketSettleable(
      mkt({ outcomes: undefined, outcomePrices: undefined }),
      NOW_PAST,
    );
    expect(r.settleable).toBe(false);
    expect(r.reason).toMatch(/missing/);
  });

  it("rejects when outcomes and prices have mismatched length", () => {
    const r = isMarketSettleable(
      mkt({ outcomes: ["A", "B", "C"], outcomePrices: ["1", "0"] }),
      NOW_PAST,
    );
    expect(r.settleable).toBe(false);
    expect(r.reason).toMatch(/missing/);
  });

  it("picks the right index for multi-outcome markets", () => {
    const r = isMarketSettleable(
      mkt({
        outcomes: ["A", "B", "C", "D"],
        outcomePrices: ["0.1", "0.0", "0.99", "0.0"],
      }),
      NOW_PAST,
    );
    expect(r.settleable).toBe(true);
    expect(r.winningOutcome).toBe("C");
  });

  it("handles markets with no endDate (no buffer enforced)", () => {
    const r = isMarketSettleable(
      mkt({ endDate: undefined }),
      new Date("2020-01-01T00:00:00Z"),
    );
    expect(r.settleable).toBe(true);
  });

  // UMA resolution status checks (plural JSON string array from Gamma API)
  it("rejects when umaResolutionStatuses contains 'proposed' (dispute window open)", () => {
    const r = isMarketSettleable(
      mkt({ umaResolutionStatuses: '["proposed"]' } as Partial<PolymarketMarket>),
      NOW_PAST,
    );
    expect(r.settleable).toBe(false);
    expect(r.reason).toMatch(/UMA/);
  });

  it("allows when umaResolutionStatuses contains 'resolved'", () => {
    const r = isMarketSettleable(
      mkt({ umaResolutionStatuses: '["resolved"]' } as Partial<PolymarketMarket>),
      NOW_PAST,
    );
    expect(r.settleable).toBe(true);
  });

  it("allows when umaResolutionStatuses is absent (older markets)", () => {
    const r = isMarketSettleable(
      mkt({ umaResolutionStatuses: undefined } as Partial<PolymarketMarket>),
      NOW_PAST,
    );
    expect(r.settleable).toBe(true);
  });

  it("allows when umaResolutionStatuses is empty array '[]'", () => {
    const r = isMarketSettleable(
      mkt({ umaResolutionStatuses: "[]" } as Partial<PolymarketMarket>),
      NOW_PAST,
    );
    expect(r.settleable).toBe(true);
  });

  it("rejects when umaResolutionStatuses contains 'disputed'", () => {
    const r = isMarketSettleable(
      mkt({ umaResolutionStatuses: '["disputed"]' } as Partial<PolymarketMarket>),
      NOW_PAST,
    );
    expect(r.settleable).toBe(false);
    expect(r.reason).toMatch(/UMA.*disputed/);
  });

  // Price validation
  it("rejects NaN outcome prices", () => {
    const r = isMarketSettleable(
      mkt({ outcomePrices: ["foo", "bar"] }),
      NOW_PAST,
    );
    expect(r.settleable).toBe(false);
    expect(r.reason).toMatch(/invalid/);
  });

  it("rejects prices outside [0, 1]", () => {
    const r = isMarketSettleable(
      mkt({ outcomePrices: ["1.5", "-0.1"] }),
      NOW_PAST,
    );
    expect(r.settleable).toBe(false);
    expect(r.reason).toMatch(/invalid/);
  });

  it("rejects ambiguous resolution: two outcomes at max price", () => {
    const r = isMarketSettleable(
      mkt({ outcomePrices: ["1", "1"] }),
      NOW_PAST,
    );
    expect(r.settleable).toBe(false);
    expect(r.reason).toMatch(/ambiguous/);
  });
});
