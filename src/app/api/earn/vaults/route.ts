import "server-only";
import { errorResponse, requireUser } from "@/lib/auth";
import { listVaults, vaultApy, vaultTvlUsd, vaultAssetSymbol, vaultProtocolName } from "@/lib/earn";

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
    const chainId = Number(url.searchParams.get("chainId") ?? "8453");
    const asset = url.searchParams.get("asset") ?? "USDC";
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") ?? "10")));

    const vaults = await listVaults({ chainId, asset, sortBy: "apy", limit });

    const projected = vaults.map((v) => ({
      address: v.address,
      chainId: v.chainId,
      name: v.name ?? null,
      protocol: vaultProtocolName(v) ?? "Unknown",
      asset: vaultAssetSymbol(v) ?? asset,
      apy: vaultApy(v) ?? null,
      tvl_usd: vaultTvlUsd(v) ?? null,
    }));

    return Response.json({ vaults: projected });
  } catch (e) {
    return errorResponse(e);
  }
}
