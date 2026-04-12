import "server-only";
import { basePublicClient } from "./viem";
import { sendGroupContractCall } from "./groupWallet";
import { USDC_BASE, CENTS_TO_USDC_UNITS } from "./constants";
import { ERC4626_ABI, ERC20_ABI } from "./abis";

/**
 * ERC-4626 vault helpers — redeem + transfer for payouts/withdrawals.
 *
 * Deposits go directly into the vault via LI.FI Composer (user-signed).
 * Vault address is always per-group (from the DB), never from env.
 * Signing is done via Privy server wallets — no local private keys.
 */

/**
 * Read the USDC-equivalent value held by `owner` in the vault, in cents.
 * USDC has 6 decimals → 1 cent = 10_000 base units.
 *
 * Returns null if the read fails (vault unreachable, no shares yet, etc.).
 */
export async function getVaultBalanceCents(
  vaultAddress: `0x${string}`,
  ownerAddress: `0x${string}`,
): Promise<number | null> {
  try {
    const client = basePublicClient();
    const shares = (await client.readContract({
      address: vaultAddress,
      abi: ERC4626_ABI,
      functionName: "balanceOf",
      args: [ownerAddress],
    })) as bigint;
    const assets = (await client.readContract({
      address: vaultAddress,
      abi: ERC4626_ABI,
      functionName: "convertToAssets",
      args: [shares],
    })) as bigint;
    return Number(assets / BigInt(10000));
  } catch (e) {
    console.warn("vault read failed:", (e as Error).message);
    return null;
  }
}

/**
 * Redeem USDC from the vault and transfer to a recipient.
 *
 * Steps:
 *   1. Convert amountCents → USDC base units → vault shares needed
 *   2. vault.redeem(shares, groupWallet, groupWallet) — USDC back to group wallet
 *   3. USDC.transfer(recipient, amount) — send to user's wallet
 *
 * Gas must already be present on the group wallet (funded manually by members).
 * Vault address comes from the group's DB record, not env.
 */
export async function redeemFromVault(
  privyWalletId: string,
  vaultAddress: `0x${string}`,
  groupWalletAddress: `0x${string}`,
  amountCents: number,
  recipientAddress: `0x${string}`,
): Promise<{ redeemTxHash: `0x${string}`; transferTxHash: `0x${string}` }> {
  const publicClient = basePublicClient();

  const usdcAmount = BigInt(amountCents) * CENTS_TO_USDC_UNITS;

  const sharesNeeded = (await publicClient.readContract({
    address: vaultAddress,
    abi: ERC4626_ABI,
    functionName: "convertToShares",
    args: [usdcAmount],
  })) as bigint;

  if (sharesNeeded <= BigInt(0)) {
    throw new Error(`cannot redeem: ${amountCents} cents converts to 0 vault shares`);
  }

  const redeemTxHash = await sendGroupContractCall(
    privyWalletId,
    vaultAddress,
    ERC4626_ABI,
    "redeem",
    [sharesNeeded, groupWalletAddress, groupWalletAddress],
  );
  await publicClient.waitForTransactionReceipt({ hash: redeemTxHash });

  const transferTxHash = await sendGroupContractCall(
    privyWalletId,
    USDC_BASE,
    ERC20_ABI,
    "transfer",
    [recipientAddress, usdcAmount],
  );
  await publicClient.waitForTransactionReceipt({ hash: transferTxHash });

  return { redeemTxHash, transferTxHash };
}
