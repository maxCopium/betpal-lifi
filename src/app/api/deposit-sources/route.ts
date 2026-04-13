import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/auth";
import { getChains, getConnections } from "@/lib/composer";
import { BASE_CHAIN_ID } from "@/lib/constants";

/**
 * GET /api/deposit-sources?toChain=8453&toToken=0x...
 *
 * Uses LI.FI /v1/chains + /v1/connections to build a dynamic list of
 * deposit sources (chain + token combos that can route to the group's vault).
 *
 * This replaces the hardcoded SOURCES array in the client. Every source shown
 * in the UI is validated to have a real route via LI.FI.
 */

// Popular source chains to check for connections
const SOURCE_CHAIN_IDS = [
  BASE_CHAIN_ID, // Base
  1,             // Ethereum
  137,           // Polygon
  42161,         // Arbitrum
  10,            // Optimism
  43114,         // Avalanche
  56,            // BSC
];

export type DepositSource = {
  chainId: number;
  chainName: string;
  chainLogo?: string;
  token: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
  priceUSD?: string;
};

export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const toChain = req.nextUrl.searchParams.get("toChain") ?? String(BASE_CHAIN_ID);
    const toToken = req.nextUrl.searchParams.get("toToken");
    // 1) Fetch all LI.FI chains (cached 5 min)
    const allChains = await getChains();
    const chainMap = new Map(allChains.map((c) => [c.id, c]));

    // 2) For each source chain, check connections to the target vault
    const connectionPromises = SOURCE_CHAIN_IDS.map((fromChain) =>
      getConnections({
        fromChain,
        toChain: Number(toChain),
        toToken: toToken ?? undefined,
      }).catch(() => [] as never[]),
    );

    const connectionResults = await Promise.all(connectionPromises);

    // 3) Build deposit sources from connection data
    const sources: DepositSource[] = [];

    for (let i = 0; i < SOURCE_CHAIN_IDS.length; i++) {
      const chainId = SOURCE_CHAIN_IDS[i];
      const chain = chainMap.get(chainId);
      const connections = connectionResults[i];

      for (const conn of connections) {
        // Each connection has fromTokens — these are valid deposit tokens
        for (const token of conn.fromTokens ?? []) {
          // Only show stablecoins + majors (filter by price > $0.50 to exclude dust tokens)
          const price = Number(token.priceUSD ?? 0);
          if (price < 0.5) continue;

          sources.push({
            chainId,
            chainName: chain?.name ?? `Chain ${chainId}`,
            chainLogo: chain?.logoURI,
            token: token.address,
            symbol: token.symbol,
            decimals: token.decimals,
            logoURI: token.logoURI,
            priceUSD: token.priceUSD,
          });
        }
      }
    }

    // Sort: stablecoins first, then by chain popularity
    const stableSymbols = new Set(["USDC", "USDT", "DAI", "USDbC", "USDC.e"]);
    sources.sort((a, b) => {
      const aStable = stableSymbols.has(a.symbol) ? 0 : 1;
      const bStable = stableSymbols.has(b.symbol) ? 0 : 1;
      if (aStable !== bStable) return aStable - bStable;
      // Then by source chain order
      return SOURCE_CHAIN_IDS.indexOf(a.chainId) - SOURCE_CHAIN_IDS.indexOf(b.chainId);
    });

    return NextResponse.json({
      sources,
      meta: {
        toChain: Number(toChain),
        toToken,
        chainsChecked: SOURCE_CHAIN_IDS.length,
        sourcesFound: sources.length,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
