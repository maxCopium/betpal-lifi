import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { formatUnits, getAddress, isAddress } from "viem";

/**
 * GET /api/wallet/holdings?address=0x...
 *
 * Fetches the user's non-zero token balances across popular chains via
 * LI.FI's /v1/token/balances (multi-token per chain).
 *
 * Returns holdings sorted by USD value — used for "Pay from" selector.
 */

export const maxDuration = 30;

const LIFI_BASE = "https://li.quest/v1";

const CHAINS = [
  { id: 8453, name: "Base" },
  { id: 1, name: "Ethereum" },
  { id: 137, name: "Polygon" },
  { id: 42161, name: "Arbitrum" },
  { id: 10, name: "Optimism" },
];

type TokenInfo = {
  address: string;
  symbol: string;
  decimals: number;
  name: string;
  chainId: number;
  logoURI?: string;
  priceUSD?: string;
};

type TokenBalance = TokenInfo & {
  amount: string;
  blockNumber: number;
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

/** Fetch top tokens for a chain from LI.FI */
async function getTokensForChain(chainId: number): Promise<TokenInfo[]> {
  try {
    const res = await fetch(
      `${LIFI_BASE}/tokens?chains=${chainId}&minPriceUSD=0.01`,
      {
        headers: {
          accept: "application/json",
          "x-lifi-api-key": env.lifiApiKey(),
        },
        next: { revalidate: 300 },
      },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { tokens: Record<string, TokenInfo[]> };
    return json.tokens?.[String(chainId)] ?? [];
  } catch {
    return [];
  }
}

/** Fetch token balances for a wallet on a chain via LI.FI */
async function getBalancesForChain(
  walletAddress: string,
  chainId: number,
  tokenAddresses: string[],
): Promise<TokenBalance[]> {
  try {
    const res = await fetch(`${LIFI_BASE}/token/balances`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-lifi-api-key": env.lifiApiKey(),
      },
      body: JSON.stringify({
        walletAddress,
        chainId,
        tokenAddresses,
      }),
    });
    if (!res.ok) return [];
    return (await res.json()) as TokenBalance[];
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  try {
    const me = await requireUser(req);
    const address = req.nextUrl.searchParams.get("address");
    if (!address || !isAddress(address)) {
      return NextResponse.json({ error: "invalid address" }, { status: 400 });
    }
    const wallet = getAddress(address);
    if (wallet.toLowerCase() !== me.walletAddress.toLowerCase()) {
      return NextResponse.json(
        { error: "can only query your own wallet" },
        { status: 403 },
      );
    }

    // Fetch tokens for all chains in parallel
    const chainTokens = await Promise.all(
      CHAINS.map(async (chain) => {
        const tokens = await getTokensForChain(chain.id);
        // Take top 15 by price to keep it fast
        const sorted = [...tokens]
          .sort((a, b) => Number(b.priceUSD ?? 0) - Number(a.priceUSD ?? 0))
          .slice(0, 15);
        return { chain, tokens: sorted };
      }),
    );

    // Fetch balances for all chains in parallel
    const allHoldings: Holding[] = [];
    const balanceResults = await Promise.all(
      chainTokens.map(({ chain, tokens }) => {
        if (tokens.length === 0) return Promise.resolve([]);
        return getBalancesForChain(
          wallet,
          chain.id,
          tokens.map((t) => t.address),
        );
      }),
    );

    for (let i = 0; i < CHAINS.length; i++) {
      const chain = CHAINS[i];
      const balances = balanceResults[i];
      const tokenMap = new Map(
        chainTokens[i].tokens.map((t) => [t.address.toLowerCase(), t]),
      );

      for (const bal of balances) {
        const raw = BigInt(bal.amount ?? "0");
        if (raw <= BigInt(0)) continue;

        const token = tokenMap.get(bal.address.toLowerCase()) ?? bal;
        const formatted = formatUnits(raw, token.decimals);
        const valueUSD = Number(token.priceUSD ?? 0) * Number(formatted);

        // Skip dust (< $0.01)
        if (valueUSD < 0.01) continue;

        allHoldings.push({
          chainId: chain.id,
          chainName: chain.name,
          token: token.address,
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          balance: raw.toString(),
          balanceFormatted: formatted,
          logoURI: token.logoURI,
          priceUSD: token.priceUSD,
          valueUSD,
        });
      }
    }

    // Sort by USD value descending
    allHoldings.sort((a, b) => b.valueUSD - a.valueUSD);

    return NextResponse.json({ holdings: allHoldings });
  } catch (err) {
    return errorResponse(err);
  }
}
