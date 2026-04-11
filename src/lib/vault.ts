import "server-only";
import { basePublicClient } from "./viem";
import { sendGroupContractCall } from "./groupWallet";
import { env } from "./env";

/**
 * ERC-4626 vault helpers + on-chain redeem/transfer for custodial payouts.
 *
 * Signing is done via Privy server wallets — no local private keys.
 * USDC on Base: 6 decimals → 1 cent = 10_000 base units.
 */

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const CENTS_TO_USDC_UNITS = BigInt(10_000); // 1 cent = 10,000 USDC base units

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
  {
    type: "function",
    name: "convertToShares",
    stateMutability: "view",
    inputs: [{ type: "uint256", name: "assets" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "redeem",
    stateMutability: "nonpayable",
    inputs: [
      { type: "uint256", name: "shares" },
      { type: "address", name: "receiver" },
      { type: "address", name: "owner" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "to" },
      { type: "uint256", name: "amount" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

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
 * Redeem USDC from the Morpho vault and transfer to a recipient.
 *
 * Steps:
 *   1. Convert amountCents → USDC base units → vault shares needed
 *   2. vault.redeem(shares, groupWallet, groupWallet) — USDC back to group wallet
 *   3. USDC.transfer(recipient, amount) — send to user's wallet
 *
 * Signing is via Privy server wallet (privyWalletId). No local keys.
 * Returns the tx hashes for both operations, or throws on failure.
 */
export async function redeemFromVault(
  privyWalletId: string,
  groupWalletAddress: `0x${string}`,
  amountCents: number,
  recipientAddress: `0x${string}`,
): Promise<{ redeemTxHash: `0x${string}`; transferTxHash: `0x${string}` }> {
  const vaultAddress = env.morphoVaultBase() as `0x${string}`;
  const publicClient = basePublicClient();

  // Convert cents to USDC base units (6 decimals).
  const usdcAmount = BigInt(amountCents) * CENTS_TO_USDC_UNITS;

  // How many vault shares do we need to redeem for this USDC amount?
  const sharesNeeded = (await publicClient.readContract({
    address: vaultAddress,
    abi: ERC4626_ABI,
    functionName: "convertToShares",
    args: [usdcAmount],
  })) as bigint;

  if (sharesNeeded <= BigInt(0)) {
    throw new Error(`cannot redeem: ${amountCents} cents converts to 0 vault shares`);
  }

  // Redeem shares → USDC arrives at the group wallet.
  const redeemTxHash = await sendGroupContractCall(
    privyWalletId,
    vaultAddress,
    ERC4626_ABI,
    "redeem",
    [sharesNeeded, groupWalletAddress, groupWalletAddress],
  );
  await publicClient.waitForTransactionReceipt({ hash: redeemTxHash });

  // Transfer USDC from group wallet to recipient.
  const transferTxHash = await sendGroupContractCall(
    privyWalletId,
    USDC_BASE as `0x${string}`,
    ERC20_TRANSFER_ABI,
    "transfer",
    [recipientAddress, usdcAmount],
  );
  await publicClient.waitForTransactionReceipt({ hash: transferTxHash });

  return { redeemTxHash, transferTxHash };
}
