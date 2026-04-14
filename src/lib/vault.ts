import "server-only";
import { parseEther } from "viem";
import { basePublicClient } from "./viem";
import { sendGroupContractCall, sendGroupTransaction } from "./groupWallet";
import { USDC_BASE, CENTS_TO_USDC_UNITS, BASE_CHAIN_ID } from "./constants";
import { ERC4626_ABI, ERC20_ABI } from "./abis";
import { getComposerReverseQuote } from "./composer";

/**
 * ERC-4626 vault helpers — redeem + transfer for payouts/withdrawals.
 *
 * Deposits go directly into the vault via LI.FI Composer (user-signed).
 * Withdrawals try LI.FI Composer first (atomic shares→USDC straight to
 * the user's wallet) and fall back to the standard ERC-4626
 * redeem(shares, receiver, owner) + USDC.transfer two-step if Composer
 * has no return route for this vault.
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

  // ── Path A: try LI.FI Composer (atomic shares→USDC straight to user) ──
  // Some vaults have a return route via LI.FI; if so, we can do the entire
  // payout in one tx with no intermediate USDC sitting in the group wallet.
  try {
    const quote = await getComposerReverseQuote({
      fromChain: BASE_CHAIN_ID,
      toChain: BASE_CHAIN_ID,
      fromToken: vaultAddress,
      toToken: USDC_BASE,
      toAmount: usdcAmount.toString(),
      fromAddress: groupWalletAddress,
      toAddress: recipientAddress,
      slippage: 0.005,
    });

    // Sanity check: required input shares must fit our balance.
    const requiredShares = BigInt(
      (quote.estimate as { fromAmount?: string }).fromAmount ?? "0",
    );
    if (requiredShares === BigInt(0) || requiredShares > sharesHeld) {
      throw new Error(
        `Composer requires ${requiredShares} shares but group holds ${sharesHeld}`,
      );
    }

    // Approve the LI.FI diamond to pull our vault shares.
    const diamond = quote.transactionRequest.to as `0x${string}`;
    const approveHash = await sendGroupContractCall(
      privyWalletId,
      vaultAddress,
      ERC20_ABI,
      "approve",
      [diamond, requiredShares],
    );
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (approveReceipt.status !== "success") {
      throw new Error(`vault approve reverted (${approveHash})`);
    }

    // Execute the Composer tx — USDC lands directly in recipient wallet.
    const composerHash = await sendGroupTransaction(
      privyWalletId,
      diamond,
      quote.transactionRequest.data as `0x${string}`,
      groupWalletAddress,
    );
    const composerReceipt = await publicClient.waitForTransactionReceipt({ hash: composerHash });
    if (composerReceipt.status !== "success") {
      throw new Error(`Composer tx reverted on-chain (${composerHash})`);
    }

    return { redeemTxHash: composerHash, transferTxHash: composerHash };
  } catch (composerErr) {
    console.warn(
      `Composer withdrawal unavailable, falling back to direct redeem: ${(composerErr as Error).message}`,
    );
  }

  // ── Path B: direct ERC-4626 redeem + USDC.transfer (always works) ──
  // Snapshot USDC balance so we can transfer exactly what redeem produces
  // (vault rounding can yield slightly fewer assets than convertToShares
  // predicted — transferring the requested amount would then revert).
  const usdcBefore = (await publicClient.readContract({
    address: USDC_BASE,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [groupWalletAddress],
  })) as bigint;

  // 2. vault.redeem — USDC lands in group wallet.
  const redeemTxHash = await sendGroupContractCall(
    privyWalletId,
    vaultAddress,
    ERC4626_ABI,
    "redeem",
    [sharesToRedeem, groupWalletAddress, groupWalletAddress],
  );
  const redeemReceipt = await publicClient.waitForTransactionReceipt({ hash: redeemTxHash });
  if (redeemReceipt.status !== "success") {
    throw new Error(`vault.redeem reverted on-chain (${redeemTxHash})`);
  }

  // Compute actual assets received from the redeem (delta on USDC balance).
  // Transfer min(requested, received) so the recipient gets what they asked
  // for when the vault gave us enough, or all of the redeemed dust when it
  // gave us slightly less.
  const usdcAfter = (await publicClient.readContract({
    address: USDC_BASE,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [groupWalletAddress],
  })) as bigint;
  const received = usdcAfter - usdcBefore;
  if (received <= BigInt(0)) {
    throw new PartialRedeemError(
      redeemTxHash,
      new Error(`redeem produced no USDC (before=${usdcBefore} after=${usdcAfter})`),
    );
  }
  const transferAmount = received < usdcAmount ? received : usdcAmount;

  // 3. Transfer USDC to recipient. Retry once: vault shares are already
  // gone — we MUST get USDC out. Throws PartialRedeemError on permanent fail.
  async function doTransfer(): Promise<`0x${string}`> {
    const hash = await sendGroupContractCall(
      privyWalletId,
      USDC_BASE,
      ERC20_ABI,
      "transfer",
      [recipientAddress, transferAmount],
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`USDC.transfer reverted on-chain (${hash})`);
    }
    return hash;
  }

  let transferTxHash: `0x${string}`;
  try {
    transferTxHash = await doTransfer();
  } catch (firstErr) {
    console.warn(`USDC transfer failed, retrying once: ${(firstErr as Error).message}`);
    try {
      transferTxHash = await doTransfer();
    } catch (retryErr) {
      throw new PartialRedeemError(redeemTxHash, retryErr as Error);
    }
  }

  return { redeemTxHash, transferTxHash };
}
