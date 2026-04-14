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
 * Withdrawals use the standard ERC-4626 redeem(shares, receiver, owner)
 * call, signed by the group's Privy server wallet, then USDC.transfer to
 * the recipient. We do NOT use LI.FI for withdrawals because not every
 * vault has a return route in the LI.FI router.
 *
 * Vault address is always per-group (from the DB), never from env.
 * Signing is done via Privy server wallets — no local private keys.
 */

/**
 * Thrown when vault redeem succeeded but USDC transfer to user failed.
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

// With explicit EIP-1559 fee caps in sendGroupTransaction, a Composer
// withdrawal upfront-needs ~2.5M gas × ~0.05 gwei ≈ 1.25e14 wei.
// Keep a ~4x safety floor.
const MIN_GAS_WEI = parseEther("0.0005");

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
 * Uses the standard ERC-4626 `redeem(shares, receiver, owner)` call —
 * supported by every conformant ERC-4626 vault — instead of LI.FI, which
 * doesn't have a return route for every vault token on Base.
 *
 * Steps:
 *   0. Pre-flight: group wallet has enough ETH for gas
 *   1. Convert amountCents → USDC base units → vault shares (with 1% buffer,
 *      capped at actual share balance)
 *   2. vault.redeem(shares, groupWallet, groupWallet) — USDC lands in group wallet
 *   3. USDC.transfer(recipient, amount) — retried once on failure
 *
 * If step 2 succeeds but step 3 fails after retry, throws PartialRedeemError.
 * Callers MUST handle this: the vault shares are gone and USDC is sitting
 * in the group wallet. Do NOT call redeemFromVault again — it will redeem
 * more shares.
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
    const ethHave = Number(ethBalance) / 1e18;
    throw new Error(
      `Group wallet needs at least 0.0005 ETH for gas but only has ${ethHave.toFixed(6)} ETH. ` +
      `Use "Send gas" to top up the group wallet.`,
    );
  }

  // Convert cents → exact USDC base units → shares needed.
  const usdcAmount = BigInt(amountCents) * CENTS_TO_USDC_UNITS;
  const sharesNeeded = (await publicClient.readContract({
    address: vaultAddress,
    abi: ERC4626_ABI,
    functionName: "convertToShares",
    args: [usdcAmount],
  })) as bigint;

  // 1% buffer to cover rounding / interest accrual between read and tx.
  const sharesWithBuffer = sharesNeeded + sharesNeeded / BigInt(100) + BigInt(1);

  // Cap at actual share balance held.
  const sharesHeld = (await publicClient.readContract({
    address: vaultAddress,
    abi: ERC4626_ABI,
    functionName: "balanceOf",
    args: [groupWalletAddress],
  })) as bigint;
  if (sharesHeld === BigInt(0)) {
    throw new Error("group wallet holds no vault shares");
  }
  const sharesToRedeem = sharesWithBuffer < sharesHeld ? sharesWithBuffer : sharesHeld;

  // 2. vault.redeem — USDC lands in group wallet.
  const redeemTxHash = await sendGroupContractCall(
    privyWalletId,
    vaultAddress,
    ERC4626_ABI,
    "redeem",
    [sharesToRedeem, groupWalletAddress, groupWalletAddress],
  );
  await publicClient.waitForTransactionReceipt({ hash: redeemTxHash });

  // 3. Transfer USDC to recipient. Use the requested usdcAmount (not the
  // assets returned by redeem) so the recipient gets exactly what they
  // asked for; any dust stays in the group wallet for the next withdrawal.
  // Retry once: vault shares are already gone — we MUST get USDC out.
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
    console.warn(`USDC transfer failed, retrying once: ${(firstErr as Error).message}`);
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
