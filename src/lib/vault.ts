import "server-only";
import { basePublicClient } from "./viem";

/**
 * ERC-4626 vault helpers. Used by reconciliation and yield distribution.
 */

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
] as const;

/**
 * Read the USDC-equivalent value held by `owner` in the vault, in cents.
 * USDC has 6 decimals → 1 cent = 10_000 base units.
 *
 * Returns null if the read fails (Safe not deployed, vault unreachable, etc.).
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
