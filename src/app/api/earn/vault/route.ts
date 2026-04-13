import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/auth";
import {
  getVaultDetail,
  vaultApy,
  vaultTvlUsd,
  vaultProtocolName,
  vaultAssetSymbol,
} from "@/lib/earn";

/**
 * GET /api/earn/vault?chainId=8453&address=0x...
 *
 * Fetches a single vault's live details from LI.FI Earn API:
 * APY breakdown, TVL, protocol name, underlying asset.
 * Used on the GroupDashboard to show "Your money earns X% APY".
 */
export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const chainId = req.nextUrl.searchParams.get("chainId");
    const address = req.nextUrl.searchParams.get("address");

    if (!chainId || !address) {
      return NextResponse.json(
        { error: "chainId and address are required" },
        { status: 400 },
      );
    }
    const vault = await getVaultDetail({
      chainId: Number(chainId),
      address,
    });

    const apy = vaultApy(vault);
    const tvl = vaultTvlUsd(vault);

    return NextResponse.json({
      address: vault.address,
      chainId: vault.chainId,
      name: vault.name,
      protocol: vaultProtocolName(vault),
      asset: vaultAssetSymbol(vault),
      apy: apy != null ? { total: apy, base: vault.analytics?.apy?.base, reward: vault.analytics?.apy?.reward } : null,
      tvl: tvl != null ? { usd: tvl } : null,
      description: vault.description,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
