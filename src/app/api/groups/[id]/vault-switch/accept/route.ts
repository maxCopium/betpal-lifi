import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { sendGroupContractCall } from "@/lib/groupWallet";
import { basePublicClient } from "@/lib/viem";
import { findVaultByAddress, vaultApy } from "@/lib/earn";
import { USDC_BASE } from "@/lib/constants";
import { ERC4626_ABI, ERC20_ABI } from "@/lib/abis";

/**
 * POST /api/groups/:id/vault-switch/accept
 *
 * Second pair of eyes: a DIFFERENT member accepts the pending vault switch.
 * Executes the on-chain migration: old vault → USDC → new vault.
 */

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId } = await params;

    const sb = supabaseService();

    // Membership check
    const { data: membership } = await sb
      .from("group_members")
      .select("user_id")
      .eq("group_id", groupId)
      .eq("user_id", me.id)
      .maybeSingle();
    if (!membership) throw new HttpError(403, "not a member of this group");

    // Load group with proposal
    const { data: group } = await sb
      .from("groups")
      .select("id, wallet_address, privy_wallet_id, vault_address, vault_chain_id, pending_vault_address, pending_vault_proposed_by")
      .eq("id", groupId)
      .single();
    if (!group) throw new HttpError(404, "group not found");
    if (!group.pending_vault_address) {
      throw new HttpError(409, "no vault switch proposal pending");
    }
    if (!group.wallet_address) {
      throw new HttpError(409, "group wallet address not set");
    }
    if (!group.privy_wallet_id) {
      throw new HttpError(409, "group wallet signing key not set (privy_wallet_id missing)");
    }

    // 4-eye: accepter must be different from proposer
    if (group.pending_vault_proposed_by === me.id) {
      throw new HttpError(403, "you proposed this switch — a different member must accept");
    }

    const oldVault = (group.vault_address as string).toLowerCase() as `0x${string}`;
    const newVault = (group.pending_vault_address as string).toLowerCase() as `0x${string}`;
    const walletId = group.privy_wallet_id as string;
    const wallet = group.wallet_address as `0x${string}`;
    const client = basePublicClient();

    // Execute on-chain migration
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
      // Redeem all from old vault
      redeemTxHash = await sendGroupContractCall(
        walletId, oldVault, ERC4626_ABI, "redeem",
        [oldShares, wallet, wallet],
      );
      await client.waitForTransactionReceipt({ hash: redeemTxHash });

      // Check USDC balance
      usdcMigrated = (await client.readContract({
        address: USDC_BASE,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [wallet],
      })) as bigint;

      if (usdcMigrated > BigInt(0)) {
        try {
          // Approve new vault
          const approveTx = await sendGroupContractCall(
            walletId, USDC_BASE, ERC20_ABI, "approve",
            [newVault, usdcMigrated],
          );
          await client.waitForTransactionReceipt({ hash: approveTx });

          // Deposit into new vault
          depositTxHash = await sendGroupContractCall(
            walletId, newVault, ERC4626_ABI, "deposit",
            [usdcMigrated, wallet],
          );
          await client.waitForTransactionReceipt({ hash: depositTxHash });
        } catch (depositErr) {
          // New vault deposit failed — re-deposit USDC back into old vault
          // so funds aren't left sitting in the wallet unprotected.
          console.error("new vault deposit failed, reverting to old vault:", (depositErr as Error).message);
          try {
            const reApprove = await sendGroupContractCall(
              walletId, USDC_BASE, ERC20_ABI, "approve",
              [oldVault, usdcMigrated],
            );
            await client.waitForTransactionReceipt({ hash: reApprove });
            await sendGroupContractCall(
              walletId, oldVault, ERC4626_ABI, "deposit",
              [usdcMigrated, wallet],
            );
          } catch (revertErr) {
            console.error("revert to old vault also failed — USDC in group wallet:", (revertErr as Error).message);
          }
          // Clear proposal but keep old vault address
          await sb.from("groups").update({
            pending_vault_address: null,
            pending_vault_proposed_by: null,
            pending_vault_proposed_at: null,
          }).eq("id", groupId);
          throw new HttpError(502, `vault switch failed — funds restored to old vault: ${(depositErr as Error).message}`);
        }
      }
    }

    // Update DB: set new vault, clear proposal
    const { error: updateErr } = await sb
      .from("groups")
      .update({
        vault_address: newVault,
        pending_vault_address: null,
        pending_vault_proposed_by: null,
        pending_vault_proposed_at: null,
      })
      .eq("id", groupId);
    if (updateErr) {
      throw new HttpError(500, `DB update failed: ${updateErr.message}`);
    }

    // Get new vault info for response
    let newVaultApy: number | undefined;
    let newVaultName: string | undefined;
    try {
      const found = await findVaultByAddress({
        chainId: Number(group.vault_chain_id),
        address: newVault,
      });
      if (found) {
        newVaultApy = vaultApy(found);
        newVaultName = found.name;
      }
    } catch { /* silent */ }

    return Response.json({
      status: "accepted",
      previous_vault: oldVault,
      new_vault: newVault,
      new_vault_name: newVaultName,
      new_vault_apy: newVaultApy,
      usdc_migrated_cents: Number(usdcMigrated / BigInt(10_000)),
      redeem_tx: redeemTxHash,
      deposit_tx: depositTxHash,
      accepted_by: me.id,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
