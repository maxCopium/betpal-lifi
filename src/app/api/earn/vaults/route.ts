import "server-only";
import { HttpError, errorResponse, requireUser } from "@/lib/auth";
import { listVaults, vaultApy, vaultTvlUsd, vaultAssetSymbol, vaultProtocolName, isFullyTransactable } from "@/lib/earn";
import { BASE_CHAIN_ID } from "@/lib/constants";

/**
 * GET /api/earn/vaults?chainId=8453&asset=USDC&limit=10
 *
 * Returns yield opportunities from the LI.FI Earn API, projected to a
 * compact shape for the group-creation vault picker.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    await requireUser(request);
    const url = new URL(request.url);
    const chainId = Number(url.searchParams.get("chainId") ?? String(BASE_CHAIN_ID));
    const asset = url.searchParams.get("asset") ?? "USDC";
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") ?? "10")));

    let vaults;
    try {
      vaults = await listVaults({ chainId, asset, sortBy: "tvl", limit: Math.max(limit, 20) });
    } catch (fetchErr) {
      throw new HttpError(502, `LI.FI Earn API failed: ${(fetchErr as Error).message}`);
    }

    // Hide vaults that LI.FI cannot round-trip (no deposit route or no
    // redeem route). Picking one of those would leave the user's funds
    // unreachable through the app.
    const projected = vaults
      .filter(isFullyTransactable)
      .map((v) => {
        const tvl = vaultTvlUsd(v) ?? 0;
        return {
          address: v.address,
          chainId: v.chainId,
          name: v.name ?? null,
          protocol: vaultProtocolName(v) ?? "Unknown",
          asset: vaultAssetSymbol(v) ?? asset,
          apy: vaultApy(v) ?? null,
          tvl_usd: tvl || null,
          risk: tvl >= 10_000_000 ? "low" : tvl >= 1_000_000 ? "medium" : "high",
        };
      })
      .sort((a, b) => (b.tvl_usd ?? 0) - (a.tvl_usd ?? 0))
      .slice(0, limit);

    return Response.json({ vaults: projected });
  } catch (e) {
    return errorResponse(e);
  }
}
