import "server-only";
import { formatUnits } from "viem";
import { env } from "@/lib/env";

/**
 * Thin wrapper around LI.FI's hosted balance + token endpoints.
 *
 * - `GET /v1/wallets/{addr}/balances` — pre-indexed balances across ~38
 *   chains in one HTTP call (~230ms). Replaces the old per-chain viem
 *   Multicall3 approach that was timing out on Vercel's 10s gateway.
 * - `GET /v1/tokens?chains=...&minPriceUSD=0.10` — token metadata +
 *   pricing. Cached for 5 minutes via Next's Data Cache. The 0.10 floor
 *   trims the payload from ~4.9MB → ~1.85MB while still retaining USDC
 *   and every stablecoin we care about on our target chains.
 *
 * Shared by /api/wallet/holdings (multi-chain picker) and
 * /api/wallet/balance (Base-only sidebar list).
 */

const LIFI_BASE = "https://li.quest/v1";

export type LifiBalanceToken = {
  address: string;
  symbol: string;
  decimals: number;
  amount: string;
  name: string;
  chainId: number;
  priceUSD?: string;
  blockNumber?: number;
};

export type LifiBalancesResponse = {
  walletAddress: string;
  balances: Record<string, LifiBalanceToken[]>;
};

export type LifiTokenInfo = {
  address: string;
  symbol: string;
  decimals: number;
  name: string;
  logoURI?: string;
  priceUSD?: string;
};

export type EnrichedHolding = {
  chainId: number;
  chainName: string;
  token: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;
  balanceFormatted: string;
  logoURI?: string;
  priceUSD?: string;
  valueUSD: number;
};

/** One hop: `GET /v1/wallets/{addr}/balances`. Single shot, hosted. */
export async function fetchLifiBalances(
  wallet: `0x${string}`,
): Promise<LifiBalancesResponse> {
  const res = await fetch(`${LIFI_BASE}/wallets/${wallet}/balances`, {
    headers: {
      accept: "application/json",
      "x-lifi-api-key": env.lifiApiKey(),
    },
    // Wallet balances change constantly — no caching.
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`LI.FI balances ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as LifiBalancesResponse;
}

/** Token metadata + prices for the requested chains. Cached 5 min. */
export async function fetchLifiTokens(
  chainIds: number[],
): Promise<Map<string, LifiTokenInfo>> {
  const res = await fetch(
    `${LIFI_BASE}/tokens?chains=${chainIds.join(",")}&minPriceUSD=0.10`,
    {
      headers: {
        accept: "application/json",
        "x-lifi-api-key": env.lifiApiKey(),
      },
      next: { revalidate: 300 },
    },
  );
  if (!res.ok) return new Map();
  const json = (await res.json()) as {
    tokens: Record<string, LifiTokenInfo[]>;
  };
  // Key on `${chainId}:${addressLower}` so price lookup is O(1).
  const out = new Map<string, LifiTokenInfo>();
  for (const [cid, list] of Object.entries(json.tokens ?? {})) {
    for (const t of list) {
      out.set(`${cid}:${t.address.toLowerCase()}`, t);
    }
  }
  return out;
}

/**
 * Merge the raw LI.FI balance response with token metadata into the
 * flat, priced `EnrichedHolding` shape we return to the client.
 *
 * Dust filter: drop tokens under $0.01, except for native tokens which
 * we always surface above a minimum amount so users can see ETH for gas.
 */
export function buildEnrichedHoldings(
  balances: LifiBalancesResponse["balances"],
  tokenInfo: Map<string, LifiTokenInfo>,
  chainNames: Record<number, string>,
): EnrichedHolding[] {
  const out: EnrichedHolding[] = [];
  for (const [cidStr, tokens] of Object.entries(balances)) {
    const chainId = Number(cidStr);
    const chainName = chainNames[chainId];
    if (!chainName) continue;

    for (const t of tokens) {
      if (!t.amount || t.amount === "0") continue;
      const raw = BigInt(t.amount);
      if (raw === BigInt(0)) continue;

      const formatted = formatUnits(raw, t.decimals);
      const meta = tokenInfo.get(`${chainId}:${t.address.toLowerCase()}`);
      // Some LI.FI balance responses inline priceUSD; fall back to /v1/tokens.
      const priceUSD = t.priceUSD ?? meta?.priceUSD;
      const valueUSD = priceUSD ? Number(priceUSD) * Number(formatted) : 0;

      const isNative =
        t.address === "0x0000000000000000000000000000000000000000";
      if (!isNative && valueUSD < 0.01) continue;
      if (isNative && Number(formatted) < 0.00001) continue;

      out.push({
        chainId,
        chainName,
        token: t.address,
        symbol: meta?.symbol ?? t.symbol,
        name: meta?.name ?? t.name,
        decimals: t.decimals,
        balance: t.amount,
        balanceFormatted: formatted,
        logoURI: meta?.logoURI,
        priceUSD,
        valueUSD,
      });
    }
  }
  // Sort by USD value desc so UIs default to the most valuable holding.
  out.sort((a, b) => b.valueUSD - a.valueUSD);
  return out;
}
