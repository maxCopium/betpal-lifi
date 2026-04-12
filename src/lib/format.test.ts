import { describe, it, expect } from "vitest";
import { fmtCents, shortAddr, formatDate } from "./format";

describe("fmtCents", () => {
  it("formats whole dollar amounts", () => {
    expect(fmtCents(1000)).toBe("$10.00");
    expect(fmtCents(100)).toBe("$1.00");
  });
  it("formats cents", () => {
    expect(fmtCents(150)).toBe("$1.50");
    expect(fmtCents(1)).toBe("$0.01");
    expect(fmtCents(99)).toBe("$0.99");
  });
  it("formats zero", () => {
    expect(fmtCents(0)).toBe("$0.00");
  });
  it("formats large amounts with comma separators", () => {
    expect(fmtCents(100_000_00)).toBe("$100,000.00");
  });
});

describe("shortAddr", () => {
  it("truncates a standard 42-char address", () => {
    const addr = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    expect(shortAddr(addr)).toBe("0x8335…2913");
  });
  it("preserves the 0x prefix and last 4 chars", () => {
    const result = shortAddr("0xAbCdEf1234567890AbCdEf1234567890AbCdEf12");
    expect(result.startsWith("0xAbCd")).toBe(true);
    expect(result.endsWith("Ef12")).toBe(true);
    expect(result).toContain("…");
  });
});

describe("formatDate", () => {
  it("formats an ISO date string", () => {
    // Use a fixed UTC time, check it includes month + time
    const result = formatDate("2026-04-12T15:00:00Z");
    expect(result).toMatch(/Apr\s+12/);
    expect(result).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/);
  });
});
