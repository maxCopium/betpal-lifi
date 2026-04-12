import "server-only";
import { z } from "zod";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { getVaultBalanceCents } from "@/lib/vault";
import { sendGroupContractCall } from "@/lib/groupWallet";
import { basePublicClient } from "@/lib/viem";
import { getVaultDetail, vaultApy } from "@/lib/earn";

/**
 * POST /api/groups/:id/vault-switch
 *
 * Migrate a group's funds from the current vault to a new one.
 * Owner-only. Fails if any bets are active (open/locked/resolving).
 *
 * Steps:
 *   1. Validate new vault exists on LI.FI Earn (same chain, USDC underlying)
 *   2. Redeem all shares from old vault → USDC lands in server wallet
 *   3. Approve new vault to spend USDC
 *   4. Deposit USDC into new vault via ERC-4626 deposit()
 *   5. Update group's vault_address in DB
 *
 * This is an atomic on-chain migration: old vault → USDC → new vault.
 * All in ~3 txs on Base (~$0.12 gas).
 */

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const ERC4626_ABI = [
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ type: "address", name: "owner" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "convertToAssets", stateMutability: "view",
    inputs: [{ type: "uint256", name: "shares" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "redeem", stateMutability: "nonpayable",
    inputs: [
      { type: "uint256", name: "shares" },
      { type: "address", name: "receiver" },
      { type: "address", name: "owner" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "deposit", stateMutability: "nonpayable",
    inputs: [
      { type: "uint256", name: "assets" },
      { type: "address", name: "receiver" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "spender" },
      { type: "uint256", name: "amount" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ type: "address", name: "account" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const Body = z.object({
  newVaultAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId } = await params;
    const json = await request.json().catch(() => {
      throw new HttpError(400, "invalid json body");
    });
    const body = Body.parse(json);
    const newVault = body.newVaultAddress.toLowerCase() as `0x${string}`;

    const sb = supabaseService();

    // Owner check
    const { data: membership } = await sb
      .from("group_members")
      .select("role")
      .eq("group_id", groupId)
      .eq("user_id", me.id)
      .single();
    if (!membership || membership.role !== "owner") {
      throw new HttpError(403, "only the group owner can switch vaults");
    }

    // No active bets check
    const { count: activeBets } = await sb
      .from("bets")
      .select("id", { count: "exact", head: true })
      .eq("group_id", groupId)
      .in("status", ["open", "locked", "resolving"]);
    if (activeBets && activeBets > 0) {
      throw new HttpError(409, "cannot switch vaults while bets are active");
    }

    // Load group
    const { data: group } = await sb
      .from("groups")
      .select("id, safe_address, privy_wallet_id, vault_address, vault_chain_id")
      .eq("id", groupId)
      .single();
    if (!group || !group.safe_address || !group.privy_wallet_id) {
      throw new HttpError(409, "group wallet not initialized");
    }

    const oldVault = (group.vault_address as string).toLowerCase() as `0x${string}`;
    if (oldVault === newVault) {
      throw new HttpError(400, "new vault is the same as the current vault");
    }

    // Validate new vault on LI.FI Earn
    const newVaultDetail = await getVaultDetail({
      chainId: Number(group.vault_chain_id),
      address: newVault,
    });
    const underlying = newVaultDetail.underlyingTokens?.[0]?.address?.toLowerCase();
    if (underlying !== USDC_BASE.toLowerCase()) {
      throw new HttpError(400, "new vault must use USDC as underlying asset");
    }

    const walletId = group.privy_wallet_id as string;
    const wallet = group.safe_address as `0x${string}`;
    const client = basePublicClient();

    // Step 1: Check shares in old vault
    const oldShares = (await client.readContract({
      address: oldVault,
      abi: ERC4626_ABI,
      functionName: "balanceOf",
      args: [wallet],
    })) as bigint;

    let redeemTxHash: `0x${string}` | null = null;
    let depositTxHash: `0x${string}` | null = null;
    let usdcMigrated = BigInt(0);

    if (oldShares > BigInt(0)) {
      // Step 2: Redeem all from old vault
      redeemTxHash = await sendGroupContractCall(
        walletId, oldVault, ERC4626_ABI, "redeem",
        [oldShares, wallet, wallet],
      );
      await client.waitForTransactionReceipt({ hash: redeemTxHash });

      // Check USDC balance after redeem
      usdcMigrated = (await client.readContract({
        address: USDC_BASE,
        abi: ERC20_APPROVE_ABI,
        functionName: "balanceOf",
        args: [wallet],
      })) as bigint;

      if (usdcMigrated > BigInt(0)) {
        // Step 3: Approve new vault
        const approveTxHash = await sendGroupContractCall(
          walletId, USDC_BASE, ERC20_APPROVE_ABI, "approve",
          [newVault, usdcMigrated],
        );
        await client.waitForTransactionReceipt({ hash: approveTxHash });

        // Step 4: Deposit into new vault
        depositTxHash = await sendGroupContractCall(
          walletId, newVault, ERC4626_ABI, "deposit",
          [usdcMigrated, wallet],
        );
        await client.waitForTransactionReceipt({ hash: depositTxHash });
      }
    }

    // Step 5: Update DB
    const { error: updateErr } = await sb
      .from("groups")
      .update({ vault_address: newVault })
      .eq("id", groupId);
    if (updateErr) {
      throw new HttpError(500, `DB update failed: ${updateErr.message}`);
    }

    const newApy = vaultApy(newVaultDetail);

    return Response.json({
      previous_vault: oldVault,
      new_vault: newVault,
      new_vault_name: newVaultDetail.name,
      new_vault_apy: newApy,
      usdc_migrated_cents: Number(usdcMigrated / BigInt(10_000)),
      redeem_tx: redeemTxHash,
      deposit_tx: depositTxHash,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
