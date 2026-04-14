import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/auth";
import { getAddress, isAddress } from "viem";
import { BASE_CHAIN_ID } from "@/lib/constants";
import {
  fetchLifiBalances,
  fetchLifiTokens,
  buildEnrichedHoldings,
} from "@/lib/lifiBalances";

/**
 * GET /api/wallet/balance?address=0x...
 *
 * Returns non-zero token balances for the user's wallet on Base only.
 * Powers the SidebarWallet token list and the BetDetail "Pay from"
 * selector.
 *
 * Thin Base-filtered wrapper over `src/lib/lifiBalances.ts`, same as
 * /api/wallet/holdings. Previously used viem Multicall3 over a public
 * RPC which (a) blew past Vercel's gateway timeout when RPCs were slow
 * and (b) sorted tokens by priceUSD desc before slicing to 20, which
 * dropped stablecoins off the bottom and hid USDC from the list.
 */

export const maxDuration = 15;

const CHAIN_NAMES: Record<number, string> = {
  [BASE_CHAIN_ID]: "Base",
};

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

    const [balances, tokenInfo] = await Promise.all([
      fetchLifiBalances(wallet),
      fetchLifiTokens([BASE_CHAIN_ID]),
    ]);

    // Pluck just the Base slice from the cross-chain response.
    const baseOnly = {
      [String(BASE_CHAIN_ID)]: balances.balances[String(BASE_CHAIN_ID)] ?? [],
    };
    const holdings = buildEnrichedHoldings(baseOnly, tokenInfo, CHAIN_NAMES);

    // Legacy response shape expected by `useWalletBalances` /
    // `useWalletHoldings`: flat TokenBalance list, no chain info.
    const tokenBalances = holdings.map((h) => ({
      symbol: h.symbol,
      name: h.name,
      address: h.token,
      balance: h.balance,
      balanceFormatted: h.balanceFormatted,
      decimals: h.decimals,
      logoURI: h.logoURI,
      priceUSD: h.priceUSD,
    }));

    return NextResponse.json({
      balances: tokenBalances,
      source: "lifi-balances",
    });
  } catch (err) {
    return errorResponse(err);
  }
}
