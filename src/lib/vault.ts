import "server-only";
import { parseEther } from "viem";
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
 * Thrown when vault.redeem() succeeded but USDC.transfer() failed.
 * USDC is sitting in the group wallet — the vault shares are gone.
 * Callers must NOT re-attempt redeemFromVault or they'll redeem more shares.
 */
export class PartialRedeemError extends Error {
  redeemTxHash: `0x${string}`;
  constructor(redeemTxHash: `0x${string}`, cause: Error) {
    super(`redeem succeeded (${redeemTxHash}) but transfer failed: ${cause.message}`);
    this.name = "PartialRedeemError";
    this.redeemTxHash = redeemTxHash;
  }
}

/** Minimum ETH needed for ~2 on-chain txs on Base. */
const MIN_GAS_WEI = parseEther("0.00004");

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
 *   0. Pre-flight: check group wallet has enough ETH for gas
 *   1. Convert amountCents → USDC base units → vault shares needed
 *   2. vault.redeem(shares, groupWallet, groupWallet) — USDC back to group wallet
 *   3. USDC.transfer(recipient, amount) — send to user's wallet (retried once)
 *
 * If step 2 succeeds but step 3 fails after retry, throws PartialRedeemError.
 * Callers MUST handle this: the vault shares are gone, USDC is in the group
 * wallet. Do NOT call redeemFromVault again — it will redeem more shares.
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

  // Pre-flight gas check
  const ethBalance = await publicClient.getBalance({ address: groupWalletAddress });
  if (ethBalance < MIN_GAS_WEI) {
    throw new Error(
      `group wallet has insufficient gas: ${ethBalance} wei < ${MIN_GAS_WEI} wei minimum. ` +
      `Send Base ETH to ${groupWalletAddress}`,
    );
  }

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

  // Transfer USDC to recipient — retry once on failure since vault shares
  // are already redeemed and USDC is sitting in the group wallet.
  let transferTxHash: `0x${string}`;
  try {
    transferTxHash = await sendGroupContractCall(
      privyWalletId,
      USDC_BASE,
      ERC20_ABI,
      "transfer",
      [recipientAddress, usdcAmount],
    );
    await publicClient.waitForTransactionReceipt({ hash: transferTxHash });
  } catch (firstErr) {
    console.warn(`transfer failed, retrying once: ${(firstErr as Error).message}`);
    try {
      transferTxHash = await sendGroupContractCall(
        privyWalletId,
        USDC_BASE,
        ERC20_ABI,
        "transfer",
        [recipientAddress, usdcAmount],
      );
      await publicClient.waitForTransactionReceipt({ hash: transferTxHash });
    } catch (retryErr) {
      throw new PartialRedeemError(redeemTxHash, retryErr as Error);
    }
  }

  return { redeemTxHash, transferTxHash };
}
