import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { basePublicClient } from "@/lib/viem";
import { ensureGas } from "@/lib/gas";
import { env } from "@/lib/env";

/**
 * GET /api/groups/:id/gas
 *
 * Returns the server wallet's ETH balance on Base (for gas).
 * Used by the dashboard to warn if the wallet needs funding.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId } = await params;

    const sb = supabaseService();
    const { data: membership } = await sb
      .from("group_members")
      .select("user_id")
      .eq("group_id", groupId)
      .eq("user_id", me.id)
      .maybeSingle();
    if (!membership) throw new HttpError(403, "not a member of this group");

    const { data: group } = await sb
      .from("groups")
      .select("wallet_address")
      .eq("id", groupId)
      .single();
    if (!group?.wallet_address) {
      throw new HttpError(409, "group wallet not initialized");
    }

    const client = basePublicClient();
    const balanceWei = await client.getBalance({
      address: group.wallet_address as `0x${string}`,
    });

    // Approximate cost per tx on Base: ~0.00002 ETH
    const costPerTx = BigInt(20_000_000_000_000); // 0.00002 ETH in wei
    const txsAffordable = Number(balanceWei / costPerTx);
    const needsFunding = balanceWei < costPerTx * BigInt(5); // warn if < 5 txs

    return Response.json({
      wallet_address: group.wallet_address,
      balance_wei: balanceWei.toString(),
      balance_eth: Number(balanceWei) / 1e18,
      txs_affordable: txsAffordable,
      needs_funding: needsFunding,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * POST /api/groups/:id/gas
 *
 * Trigger auto gas funding for the group wallet.
 * Uses the GAS_FUNDER_PRIVY_WALLET_ID env var as the funding source.
 * Optionally accepts { funderWalletId } in the body to override.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId } = await params;

    const sb = supabaseService();
    const { data: membership } = await sb
      .from("group_members")
      .select("role")
      .eq("group_id", groupId)
      .eq("user_id", me.id)
      .maybeSingle();
    if (!membership) throw new HttpError(403, "not a member of this group");

    const { data: group } = await sb
      .from("groups")
      .select("wallet_address, privy_wallet_id")
      .eq("id", groupId)
      .single();
    if (!group?.wallet_address) {
      throw new HttpError(409, "group wallet not initialized");
    }

    // Allow body override, fall back to env
    let funderWalletId: string | undefined;
    try {
      const body = await request.json();
      funderWalletId = body?.funderWalletId;
    } catch {
      // empty body is fine
    }
    funderWalletId = funderWalletId || env.gasFunderPrivyWalletId();

    if (!funderWalletId) {
      throw new HttpError(
        400,
        "no funder wallet configured — set GAS_FUNDER_PRIVY_WALLET_ID or pass funderWalletId in body",
      );
    }

    const txHash = await ensureGas(
      group.wallet_address as `0x${string}`,
      funderWalletId,
    );

    if (!txHash) {
      return Response.json({ funded: false, reason: "balance sufficient" });
    }

    return Response.json({ funded: true, tx_hash: txHash });
  } catch (e) {
    return errorResponse(e);
  }
}
