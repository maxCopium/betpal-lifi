import "server-only";
import { z } from "zod";
import { BASE_CHAIN_ID } from "./constants";

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
            base: z.number().nullish(),
            reward: z.number().nullish(),
            total: z.number(),
            // Historical APY points — useful for "past 7d yield" UI.
            apy1d: z.number().nullish(),
            apy7d: z.number().nullish(),
            apy30d: z.number().nullish(),
          })
          .passthrough()
          .nullish(),
        tvl: z
          .object({
            usd: z.union([z.string(), z.number()]).nullish(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .optional(),
    tags: z.array(z.string()).optional(),
    // LI.FI's routing packs — empty `redeemPacks` means no Composer return
    // route, even if `isRedeemable` is true. Belt-and-braces filter.
    depositPacks: z.array(z.unknown()).optional(),
    redeemPacks: z.array(z.unknown()).optional(),
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
  tags?: string | string[];
}): Promise<EarnVault[]> {
  const url = new URL(`${EARN_BASE}/v1/earn/vaults`);
  if (opts.chainId) url.searchParams.set("chainId", String(opts.chainId));
  if (opts.asset) url.searchParams.set("asset", opts.asset);
  if (opts.sortBy) url.searchParams.set("sortBy", opts.sortBy);
  if (opts.limit) url.searchParams.set("limit", String(opts.limit));
  if (opts.tags) {
    const tags = Array.isArray(opts.tags) ? opts.tags.join(",") : opts.tags;
    url.searchParams.set("tags", tags);
  }
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

/**
 * GET /v1/earn/vault — full detail for a single vault.
 * Returns APY breakdown (base/reward/total), historical APY (1d/7d/30d), TVL.
 *
 * ⚠️  This endpoint 404s for many vaults that `/v1/earn/vaults` lists just
 * fine (e.g. bbqUSDC on Base). Callers MUST be prepared to fall back to a
 * list search. Returns null on 404 so callers can do exactly that.
 */
export async function getVaultDetail(opts: {
  chainId: number;
  address: string;
}): Promise<EarnVault | null> {
  const url = new URL(`${EARN_BASE}/v1/earn/vault`);
  url.searchParams.set("chainId", String(opts.chainId));
  url.searchParams.set("address", opts.address);
  const res = await fetch(url.toString(), {
    headers: { accept: "application/json" },
    next: { revalidate: 60 }, // cache 1 min — APY changes often
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Earn /v1/earn/vault failed: ${res.status} ${body.slice(0, 500)}`,
    );
  }
  const json = await res.json();
  // API returns { data: vault } or the vault directly; normalize.
  const payload = (json && typeof json === "object" && "data" in json) ? json.data : json;
  return VaultSchema.parse(payload);
}

/**
 * Only vaults that LI.FI can actually deposit *and* redeem. Using a vault
 * without both flags is how you end up with stranded shares — LI.FI's
 * `/quote` refuses to generate a return route, so withdrawals silently
 * fall back to direct ERC-4626 which may not exist for every vault token.
 */
export function isFullyTransactable(v: EarnVault): boolean {
  if (v.isTransactional === false || v.isRedeemable === false) return false;
  // If the packs arrays are present but empty, LI.FI has no route pack
  // for that direction — treat it as non-transactable.
  if (v.depositPacks && v.depositPacks.length === 0) return false;
  if (v.redeemPacks && v.redeemPacks.length === 0) return false;
  return true;
}

/**
 * Look up a single vault by address. Tries the `/v1/earn/vault` detail
 * endpoint first (fast, one HTTP call), and only falls back to a paginated
 * list search if detail returns 404 or errors.
 *
 * The list endpoint is paginated with a small default limit, so we bump it
 * explicitly and pass the asset filter the caller can give us to narrow
 * the haystack when detail isn't available.
 */
export async function findVaultByAddress(opts: {
  chainId: number;
  address: string;
  asset?: string;
}): Promise<EarnVault | null> {
  try {
    const detail = await getVaultDetail({ chainId: opts.chainId, address: opts.address });
    if (detail) return detail;
  } catch (e) {
    console.warn(
      `getVaultDetail failed, falling back to list search: ${(e as Error).message}`,
    );
  }
  const vaults = await listVaults({
    chainId: opts.chainId,
    asset: opts.asset,
    limit: 100,
  });
  const addr = opts.address.toLowerCase();
  return vaults.find((v) => v.address.toLowerCase() === addr) ?? null;
}

/**
 * Find the highest-APY USDC vault on Base via LI.FI Earn.
 * Used at group creation to auto-select the best vault.
 *
 * Filters for `isTransactional && isRedeemable` so we never auto-pick a
 * vault that LI.FI can't round-trip. Sorts by APY among transactable
 * vaults only. Falls back to a known-good vault if the API is down.
 */
const FALLBACK_VAULT = "0xbeefe94c8ad530842bfe7d8b397938ffc1cb83b2"; // STEAKUSDC on Base

export async function bestUsdcVaultOnBase(): Promise<{ address: string; name?: string; apy?: number }> {
  try {
    // Pull more than 1 so we can filter non-transactable ones and still
    // have a winner. listVaults returns whatever LI.FI has — we filter here.
    const vaults = await listVaults({
      chainId: BASE_CHAIN_ID,
      asset: "USDC",
      sortBy: "apy",
      limit: 50,
      tags: "stablecoin",
    });
    const transactable = vaults.filter(isFullyTransactable);
    if (transactable.length > 0) {
      // listVaults already sorted by APY desc; pick the top survivor.
      return {
        address: transactable[0].address,
        name: transactable[0].name,
        apy: vaultApy(transactable[0]),
      };
    }
  } catch (e) {
    console.warn("LI.FI Earn vault discovery failed, using fallback:", (e as Error).message);
  }
  return { address: FALLBACK_VAULT };
}

