import "server-only";
import { z } from "zod";

/**
 * LI.FI Earn Data API wrapper.
 * Base URL: https://earn.li.fi
 * No auth required.
 *
 * Used for:
 *   - Vault discovery (find Morpho USDC on Base, or any vault by chain/asset)
 *   - APY/TVL analytics for the dashboard
 *   - Future: group-vote on yield markets
 *
 * Verified against live API on 2026-04-10.
 */

const EARN_BASE = "https://earn.li.fi";

const VaultSchema = z
  .object({
    address: z.string(),
    chainId: z.number(),
    name: z.string().optional(),
    slug: z.string().optional(),
    description: z.string().optional(),
    protocol: z
      .object({
        name: z.string(),
        url: z.string().optional(),
      })
      .passthrough()
      .optional(),
    underlyingTokens: z
      .array(
        z.object({
          address: z.string(),
          symbol: z.string(),
          decimals: z.number(),
        }).passthrough(),
      )
      .optional(),
    analytics: z
      .object({
        apy: z
          .object({
            base: z.number().optional(),
            reward: z.number().optional(),
            total: z.number(),
          })
          .passthrough()
          .optional(),
        tvl: z
          .object({
            usd: z.union([z.string(), z.number()]).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    isTransactional: z.boolean().optional(),
    isRedeemable: z.boolean().optional(),
  })
  .passthrough();

export type EarnVault = z.infer<typeof VaultSchema>;

/**
 * Convenience accessors that normalize the nested vault schema into flat values.
 */
export function vaultApy(v: EarnVault): number | undefined {
  return v.analytics?.apy?.total;
}

export function vaultTvlUsd(v: EarnVault): number | undefined {
  const raw = v.analytics?.tvl?.usd;
  if (raw === undefined) return undefined;
  return typeof raw === "number" ? raw : Number(raw);
}

export function vaultAssetSymbol(v: EarnVault): string | undefined {
  return v.underlyingTokens?.[0]?.symbol;
}

export function vaultProtocolName(v: EarnVault): string | undefined {
  return v.protocol?.name;
}

/**
 * GET /v1/earn/vaults — list yield opportunities.
 *
 * Supports filtering by chainId, asset symbol, and sorting by apy.
 */
export async function listVaults(opts: {
  chainId?: number;
  asset?: string;
  sortBy?: string;
  limit?: number;
}): Promise<EarnVault[]> {
  const url = new URL(`${EARN_BASE}/v1/earn/vaults`);
  if (opts.chainId) url.searchParams.set("chainId", String(opts.chainId));
  if (opts.asset) url.searchParams.set("asset", opts.asset);
  if (opts.sortBy) url.searchParams.set("sortBy", opts.sortBy);
  if (opts.limit) url.searchParams.set("limit", String(opts.limit));
  const res = await fetch(url.toString(), {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Earn /v1/earn/vaults failed: ${res.status} ${body.slice(0, 500)}`,
    );
  }
  const json = await res.json();
  const arr = Array.isArray(json) ? json : (json.data ?? []);
  return z.array(VaultSchema).parse(arr);
}

/** Read a wallet's positions across Earn-indexed vaults. */
export async function getPortfolio(walletAddress: string): Promise<unknown> {
  const url = new URL(`${EARN_BASE}/v1/earn/portfolio/${walletAddress}`);
  const res = await fetch(url.toString(), {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Earn /portfolio failed: ${res.status} ${body.slice(0, 500)}`,
    );
  }
  return res.json();
}
