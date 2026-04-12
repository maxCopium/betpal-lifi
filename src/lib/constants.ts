/**
 * Shared constants for the BetPal app.
 * Single source of truth for chain IDs, token addresses, and network config.
 *
 * No "server-only" — these are safe to import from both client and server.
 */

export const BASE_CHAIN_ID = 8453;
export const BASE_CAIP2 = `eip155:${BASE_CHAIN_ID}` as const;

/** Canonical USDC contract on Base (6 decimals). */
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

/** 1 cent = 10,000 USDC base units (6 decimals). */
export const CENTS_TO_USDC_UNITS = BigInt(10_000);

/** USDC contract on Polygon (6 decimals). */
export const USDC_POLYGON = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" as const;
export const POLYGON_CHAIN_ID = 137;
