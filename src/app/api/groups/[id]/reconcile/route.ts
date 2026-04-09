import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { basePublicClient } from "@/lib/viem";
import { getGroupTotalCents } from "@/lib/ledger";

/**
 * GET /api/groups/[id]/reconcile
 *
 * Compare the off-chain ledger sum to the on-chain Morpho vault balance for
 * the group's Safe. Returns both numbers + the drift in cents. The hourly
 * reconciliation worker (Day 5) calls the same code path.
 *
 * For now this is read-only — it does NOT auto-correct the ledger. Drift
 * detection is the first step; auto-correction (writing a `reconciliation`
 * event) is intentionally manual until we trust the read path under load.
 *
 * Vault balance is read via ERC-4626's `convertToAssets(balanceOf(safe))`,
 * which translates the Safe's vault-share holding into the underlying USDC
 * value. USDC has 6 decimals, so cents = floor(usdcUnits / 10000).
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */

const ERC4626_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address", name: "owner" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "convertToAssets",
    stateMutability: "view",
    inputs: [{ type: "uint256", name: "shares" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId } = await params;

    const sb = supabaseService();
    const { data: membership, error: memErr } = await sb
      .from("group_members")
      .select("user_id")
      .eq("group_id", groupId)
      .eq("user_id", me.id)
      .maybeSingle();
    if (memErr) throw new HttpError(500, `member check failed: ${memErr.message}`);
    if (!membership) throw new HttpError(403, "not a member of this group");

    const { data: group, error: groupErr } = await sb
      .from("groups")
      .select("id, safe_address, vault_address")
      .eq("id", groupId)
      .single();
    if (groupErr || !group) throw new HttpError(500, `group lookup failed: ${groupErr?.message}`);
    if (!group.safe_address) throw new HttpError(409, "group has no safe yet");

    const ledgerCents = await getGroupTotalCents(groupId);

    const client = basePublicClient();
    let onChainCents = 0;
    let onChainAvailable = false;
    try {
      const shares = (await client.readContract({
        address: group.vault_address as `0x${string}`,
        abi: ERC4626_ABI,
        functionName: "balanceOf",
        args: [group.safe_address as `0x${string}`],
      })) as bigint;
      const assets = (await client.readContract({
        address: group.vault_address as `0x${string}`,
        abi: ERC4626_ABI,
        functionName: "convertToAssets",
        args: [shares],
      })) as bigint;
      // USDC has 6 decimals → 1 cent = 10_000 base units.
      onChainCents = Number(assets / BigInt(10000));
      onChainAvailable = true;
    } catch (e) {
      // The Safe may not be deployed yet; or the vault address may be wrong.
      // Either way, return ledger-only with a note rather than 500-ing.
      console.warn("vault read failed:", (e as Error).message);
    }

    return Response.json({
      group_id: groupId,
      safe_address: group.safe_address,
      vault_address: group.vault_address,
      ledger_cents: ledgerCents,
      onchain_cents: onChainAvailable ? onChainCents : null,
      drift_cents: onChainAvailable ? onChainCents - ledgerCents : null,
      onchain_available: onChainAvailable,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
