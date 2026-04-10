import { describe, it, expect } from "vitest";
import { toBaseUnits } from "./amounts";

describe("toBaseUnits", () => {
  describe("USDC (6 decimals)", () => {
    it("converts whole numbers", () => {
      expect(toBaseUnits("10", 6)).toBe("10000000");
      expect(toBaseUnits("1", 6)).toBe("1000000");
    });
    it("converts decimals", () => {
      expect(toBaseUnits("10.5", 6)).toBe("10500000");
      expect(toBaseUnits("0.01", 6)).toBe("10000");
      expect(toBaseUnits("1.234567", 6)).toBe("1234567");
    });
    it("zero", () => {
      expect(toBaseUnits("0", 6)).toBe("0");
      expect(toBaseUnits("0.0", 6)).toBe("0");
    });
    it("trims excess precision (no rounding up)", () => {
      // 1.2345679 → keep first 6 fractional digits → "1.234567"
      expect(toBaseUnits("1.2345679", 6)).toBe("1234567");
    });
    it("strips leading zeros from whole part", () => {
      expect(toBaseUnits("007", 6)).toBe("7000000");
      expect(toBaseUnits("00.5", 6)).toBe("500000");
    });
    it("preserves trailing-zero significance", () => {
      expect(toBaseUnits("10.000000", 6)).toBe("10000000");
    });
    it("handles a small fractional value with leading zeros", () => {
      expect(toBaseUnits("0.000001", 6)).toBe("1");
    });
  });

  describe("18 decimals (ETH)", () => {
    it("converts wei-scale amounts", () => {
      expect(toBaseUnits("1", 18)).toBe("1000000000000000000");
      expect(toBaseUnits("0.5", 18)).toBe("500000000000000000");
    });
  });

  describe("0 decimals", () => {
    it("forbids fractional inputs by truncating to nothing", () => {
      expect(toBaseUnits("100", 0)).toBe("100");
      // fractional silently dropped
      expect(toBaseUnits("100.99", 0)).toBe("100");
    });
  });

  describe("input validation", () => {
    it.each([
      "",
      " ",
      "abc",
      "1.2.3",
      "-1",
      "1e6", // scientific notation
      "1,000",
      ".5", // missing leading zero
      "1.",
    ])("rejects %s", (bad) => {
      expect(() => toBaseUnits(bad, 6)).toThrow(/invalid amount/);
    });

    it("trims surrounding whitespace before validation", () => {
      expect(toBaseUnits("  10.5  ", 6)).toBe("10500000");
    });

    it("rejects negative or non-integer decimals", () => {
      expect(() => toBaseUnits("1", -1)).toThrow(/decimals/);
      expect(() => toBaseUnits("1", 1.5)).toThrow(/decimals/);
    });
  });
});
