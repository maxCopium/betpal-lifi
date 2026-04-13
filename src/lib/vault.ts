import "server-only";
import { parseEther } from "viem";
import { basePublicClient } from "./viem";
import { sendGroupTransaction } from "./groupWallet";
import { USDC_BASE, CENTS_TO_USDC_UNITS, BASE_CHAIN_ID } from "./constants";
import { ERC4626_ABI } from "./abis";
import { getComposerQuote } from "./composer";

/**
 * ERC-4626 vault helpers — redeem + transfer for payouts/withdrawals.
 *
 * Deposits go directly into the vault via LI.FI Composer (user-signed).
 * Withdrawals use LI.FI Composer (server-signed by the group's Privy wallet).
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
 * Uses LI.FI Composer to atomically redeem vault shares → USDC.
 * Then transfers USDC from the group wallet to the user's wallet.
 *
 * Steps:
 *   0. Pre-flight: check group wallet has enough ETH for gas
 *   1. Get LI.FI quote: fromToken=vault (sell shares), toToken=USDC
 *   2. Check allowance & approve vault shares for LI.FI diamond if needed
 *   3. Execute the Composer transaction (signed by group Privy wallet)
 *   4. Transfer USDC to recipient
 *
 * If step 3 succeeds but step 4 fails after retry, throws PartialRedeemError.
 * Callers MUST handle this: the vault shares are gone, USDC is in the group
 * wallet. Do NOT call redeemFromVault again — it will redeem more shares.
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

  // Convert cents → shares needed. Use convertToShares for exact amount.
  const usdcAmount = BigInt(amountCents) * CENTS_TO_USDC_UNITS;
  const sharesNeeded = (await publicClient.readContract({
    address: vaultAddress,
    abi: ERC4626_ABI,
    functionName: "convertToShares",
    args: [usdcAmount],
  })) as bigint;

  // Add 1% buffer to shares to cover rounding / price movement
  const sharesWithBuffer = sharesNeeded + (sharesNeeded / BigInt(100)) + BigInt(1);

  // Cap at actual balance
  const sharesHeld = (await publicClient.readContract({
    address: vaultAddress,
    abi: ERC4626_ABI,
    functionName: "balanceOf",
    args: [groupWalletAddress],
  })) as bigint;

  if (sharesHeld === BigInt(0)) {
    throw new Error("group wallet holds no vault shares");
  }

  const sharesToSell = sharesWithBuffer < sharesHeld ? sharesWithBuffer : sharesHeld;

  // LI.FI Composer quote: vault shares → USDC, delivered directly to recipient.
  // fromToken = vault address (sell shares), toToken = USDC
  // toAddress = recipient's wallet — Composer delivers USDC there atomically.
  // The group's Privy server wallet signs the tx (fromAddress).
  const quote = await getComposerQuote({
    fromChain: BASE_CHAIN_ID,
    toChain: BASE_CHAIN_ID,
    fromToken: vaultAddress,
    toToken: USDC_BASE,
    fromAmount: sharesToSell.toString(),
    fromAddress: groupWalletAddress,
    toAddress: recipientAddress, // USDC goes directly to user's wallet
  });

  // Approve LI.FI diamond to spend vault shares if needed.
  const approvalAddress = (quote.estimate as Record<string, unknown>).approvalAddress as string | undefined;
  if (approvalAddress) {
    const allowanceData =
      "0xdd62ed3e" +
      groupWalletAddress.slice(2).padStart(64, "0") +
      approvalAddress.slice(2).padStart(64, "0");
    const allowanceHex = (await publicClient.call({
      to: vaultAddress,
      data: allowanceData as `0x${string}`,
    })).data;
    const allowance = BigInt(allowanceHex || "0x0");
    if (allowance < sharesToSell) {
      const approveData =
        ("0x095ea7b3" +
        approvalAddress.slice(2).padStart(64, "0") +
        "f".repeat(64)) as `0x${string}`;
      const approveTxHash = await sendGroupTransaction(
        privyWalletId,
        vaultAddress,
        approveData,
      );
      await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    }
  }

  // Execute Composer tx — vault shares → USDC → recipient wallet (atomic).
  const txReq = quote.transactionRequest;
  const txHash = await sendGroupTransaction(
    privyWalletId,
    txReq.to as `0x${string}`,
    txReq.data as `0x${string}`,
  );
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  // Single atomic tx — both redeemTxHash and transferTxHash are the same.
  return { redeemTxHash: txHash, transferTxHash: txHash };
}
