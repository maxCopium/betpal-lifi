import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { formatUnits, getAddress, isAddress } from "viem";

/**
 * GET /api/wallet/holdings?address=0x...
 *
 * Returns the user's non-zero token balances across the chains we care
 * about (Base, Ethereum, Polygon, Arbitrum, Optimism).
 *
 * Backed by LI.FI's hosted indexer at `GET /v1/wallets/{address}/balances`
 * — a single HTTP call that returns pre-computed balances across ~38
 * chains in ~150ms. This replaces the old 5-chain parallel-multicall
 * implementation which was blowing past Vercel's 10s gateway limit (the
 * 504s) and also dropping USDC off the end of the token list.
 *
 * Prices come from LI.FI `/v1/tokens` so we can show USD values.
 */

export const maxDuration = 15;

const LIFI_BASE = "https://li.quest/v1";

// Chains we surface in the UI. LI.FI returns more than this — filter here
// so the send-from dropdown stays focused on chains the user is likely to
// actually care about for EVM USDC routing.
const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum",
};

type LifiBalanceToken = {
  address: string;
  symbol: string;
  decimals: number;
  amount: string;
  name: string;
  chainId: number;
};

type LifiBalancesResponse = {
  walletAddress: string;
  balances: Record<string, LifiBalanceToken[]>;
};

type LifiTokenInfo = {
  address: string;
  symbol: string;
  decimals: number;
  name: string;
  logoURI?: string;
  priceUSD?: string;
};

export type Holding = {
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
async function fetchLifiBalances(wallet: `0x${string}`): Promise<LifiBalancesResponse> {
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

/** Token metadata + prices for the chains we care about. Cached 5 min. */
async function fetchLifiTokens(
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
  const json = (await res.json()) as { tokens: Record<string, LifiTokenInfo[]> };
  // Key on `${chainId}:${addressLower}` so price lookup is O(1).
  const out = new Map<string, LifiTokenInfo>();
  for (const [cid, list] of Object.entries(json.tokens ?? {})) {
    for (const t of list) {
      out.set(`${cid}:${t.address.toLowerCase()}`, t);
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  try {
    const me = await requireUser(req);
    const address = req.nextUrl.searchParams.get("address");
    if (!address || !isAddress(address)) {
      return NextResponse.json({ error: "invalid address" }, { status: 400 });
    }
    const wallet = getAddress(address) as `0x${string}`;
    if (wallet.toLowerCase() !== me.walletAddress.toLowerCase()) {
      return NextResponse.json(
        { error: "can only query your own wallet" },
        { status: 403 },
      );
    }

    const chainIds = Object.keys(CHAIN_NAMES).map(Number);
    const [balances, tokenInfo] = await Promise.all([
      fetchLifiBalances(wallet),
      fetchLifiTokens(chainIds),
    ]);

    const holdings: Holding[] = [];
    for (const [cidStr, tokens] of Object.entries(balances.balances)) {
      const chainId = Number(cidStr);
      const chainName = CHAIN_NAMES[chainId];
      if (!chainName) continue; // skip chains we don't support

      for (const t of tokens) {
        if (!t.amount || t.amount === "0") continue;
        const raw = BigInt(t.amount);
        if (raw === BigInt(0)) continue;

        const formatted = formatUnits(raw, t.decimals);
        const meta = tokenInfo.get(`${chainId}:${t.address.toLowerCase()}`);
        const priceUSD = meta?.priceUSD;
        const valueUSD = priceUSD ? Number(priceUSD) * Number(formatted) : 0;

        // Keep priced tokens worth ≥ $0.01 plus any native token regardless
        // of price so users always see ETH/etc. for gas. Drop dust.
        const isNative = t.address === "0x0000000000000000000000000000000000000000";
        if (!isNative && valueUSD < 0.01) continue;
        if (isNative && Number(formatted) < 0.00001) continue;

        holdings.push({
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

    // Sort by USD value desc so the picker defaults to the most valuable
    // holding when the user hasn't yet chosen.
    holdings.sort((a, b) => b.valueUSD - a.valueUSD);

    return NextResponse.json({ holdings });
  } catch (err) {
    return errorResponse(err);
  }
}
