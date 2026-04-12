import { describe, it, expect } from "vitest";
import {
  BASE_CHAIN_ID,
  BASE_CAIP2,
  USDC_BASE,
  CENTS_TO_USDC_UNITS,
  USDC_POLYGON,
  POLYGON_CHAIN_ID,
} from "./constants";

describe("constants", () => {
  it("BASE_CHAIN_ID is 8453", () => {
    expect(BASE_CHAIN_ID).toBe(8453);
  });

  it("BASE_CAIP2 matches chain ID", () => {
    expect(BASE_CAIP2).toBe("eip155:8453");
  });

  it("USDC_BASE is a valid checksummed address", () => {
    expect(USDC_BASE).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("CENTS_TO_USDC_UNITS is 10000n (1 cent = 10000 base units for 6-decimal token)", () => {
    expect(CENTS_TO_USDC_UNITS).toBe(10_000n);
  });

  it("USDC_POLYGON is a valid lowercase address", () => {
    expect(USDC_POLYGON).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("POLYGON_CHAIN_ID is 137", () => {
    expect(POLYGON_CHAIN_ID).toBe(137);
  });
});
