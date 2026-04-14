import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/auth";
import { getAddress, isAddress } from "viem";
import {
  fetchLifiBalances,
  fetchLifiTokens,
  buildEnrichedHoldings,
  type EnrichedHolding,
} from "@/lib/lifiBalances";

/**
 * GET /api/wallet/holdings?address=0x...
 *
 * Returns the user's non-zero token balances across the chains we
 * surface in the UI (Base, Ethereum, Polygon, Arbitrum, Optimism).
 *
 * Backed by LI.FI's hosted indexer — one HTTP hop for balances across
 * ~38 chains. See `src/lib/lifiBalances.ts` for the shared fetch layer
 * used by both this endpoint and /api/wallet/balance.
 */

export const maxDuration = 15;

// Chains we surface in the UI. LI.FI returns more than this — filter here
// so the send-from dropdown stays focused on chains the user is likely
// to actually care about for EVM USDC routing.
const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum",
};

export type Holding = EnrichedHolding;

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

    const holdings = buildEnrichedHoldings(
      balances.balances,
      tokenInfo,
      CHAIN_NAMES,
    );

    return NextResponse.json({ holdings });
  } catch (err) {
    return errorResponse(err);
  }
}
