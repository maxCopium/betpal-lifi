import "server-only";
import { parseEther } from "viem";
import { basePublicClient } from "./viem";
import { env } from "./env";
import { sendGroupEth } from "./groupWallet";

const MIN_GAS_WEI = parseEther("0.00005"); // ~5 txs worth
const TOP_UP_WEI = parseEther("0.0002"); // ~20 txs worth (~$0.50)

/**
 * Check if a group wallet needs gas, and top it up from a funder wallet if so.
 * The funder is another Privy server wallet that holds Base ETH.
 * Returns the tx hash if funded, null if not needed.
 */
export async function ensureGas(
  groupWalletAddress: `0x${string}`,
  funderPrivyWalletId: string,
): Promise<`0x${string}` | null> {
  const balance = await basePublicClient().getBalance({
    address: groupWalletAddress,
  });
  if (balance >= MIN_GAS_WEI) return null;

  console.log(
    `[gas] funding ${groupWalletAddress} — balance ${balance} < ${MIN_GAS_WEI}`,
  );
  return sendGroupEth(funderPrivyWalletId, groupWalletAddress, TOP_UP_WEI);
}

/**
 * Best-effort gas top-up using the configured funder wallet.
 * Swallows errors so callers can fire-and-forget before vault ops.
 * Returns the funding tx hash, or null if skipped / failed / not configured.
 */
export async function ensureGasBestEffort(
  groupWalletAddress: `0x${string}`,
): Promise<`0x${string}` | null> {
  const funderId = env.gasFunderPrivyWalletId();
  if (!funderId) return null;

  try {
    return await ensureGas(groupWalletAddress, funderId);
  } catch (e) {
    console.warn("[gas] auto-funding failed (non-fatal):", (e as Error).message);
    return null;
  }
}
