import "server-only";
import { basePublicClient } from "./viem";
import { sendGroupContractCall } from "./groupWallet";

/**
 * ERC-4626 vault helpers + on-chain deposit/redeem/transfer.
 *
 * Vault address is always per-group (from the DB), never from env.
 * Signing is done via Privy server wallets — no local private keys.
 * USDC on Base: 6 decimals → 1 cent = 10_000 base units.
 */

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
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
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { type: "uint256", name: "assets" },
      { type: "address", name: "receiver" },
    ],
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

const ERC20_ABI = [
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
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "spender" },
      { type: "uint256", name: "amount" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address", name: "account" }],
    outputs: [{ type: "uint256" }],
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
 * Deposit USDC from the group wallet into the vault.
 *
 * Steps:
 *   1. Check USDC balance on group wallet
 *   2. Approve vault to spend USDC
 *   3. vault.deposit(assets, receiver=groupWallet)
 *
 * Used after a user deposits USDC to the group wallet (via Composer or transfer).
 */
export async function depositToVault(
  privyWalletId: string,
  vaultAddress: `0x${string}`,
  groupWalletAddress: `0x${string}`,
): Promise<{ depositTxHash: `0x${string}`; amountDeposited: bigint }> {
  const publicClient = basePublicClient();

  // Check how much USDC the group wallet holds
  const usdcBalance = (await publicClient.readContract({
    address: USDC_BASE,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [groupWalletAddress],
  })) as bigint;

  if (usdcBalance <= BigInt(0)) {
    throw new Error("group wallet has no USDC to deposit into vault");
  }

  // Approve vault to spend USDC
  const approveTxHash = await sendGroupContractCall(
    privyWalletId,
    USDC_BASE,
    ERC20_ABI,
    "approve",
    [vaultAddress, usdcBalance],
  );
  await publicClient.waitForTransactionReceipt({ hash: approveTxHash });

  // Deposit USDC into vault — shares go to group wallet
  const depositTxHash = await sendGroupContractCall(
    privyWalletId,
    vaultAddress,
    ERC4626_ABI,
    "deposit",
    [usdcBalance, groupWalletAddress],
  );
  await publicClient.waitForTransactionReceipt({ hash: depositTxHash });

  return { depositTxHash, amountDeposited: usdcBalance };
}

/**
 * Redeem USDC from the vault and transfer to a recipient.
 *
 * Steps:
 *   1. Convert amountCents → USDC base units → vault shares needed
 *   2. vault.redeem(shares, groupWallet, groupWallet) — USDC back to group wallet
 *   3. USDC.transfer(recipient, amount) — send to user's wallet
 *
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
