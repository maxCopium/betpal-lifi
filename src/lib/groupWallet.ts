import "server-only";
import { PrivyClient } from "@privy-io/server-auth";
import { env } from "./env";
import { encodeFunctionData } from "viem";
import { BASE_CAIP2 } from "./constants";

/**
 * Per-group custodial wallets via Privy Server Wallets.
 *
 * Each group gets its own Privy-managed wallet. The app uses the Privy
 * wallet API to create wallets and sign transactions (vault redemptions,
 * USDC transfers, etc.) without holding any private keys.
 */

let _privy: PrivyClient | null = null;
function privy(): PrivyClient {
  if (_privy) return _privy;
  _privy = new PrivyClient(env.privyAppId(), env.privyAppSecret());
  return _privy;
}

/**
 * Create a new Privy server wallet for a group.
 * Returns the wallet id and address.
 */
export async function createGroupWallet(): Promise<{
  walletId: string;
  address: string;
}> {
  const wallet = await privy().walletApi.createWallet({
    chainType: "ethereum",
  });
  return { walletId: wallet.id, address: wallet.address };
}

/**
 * Send a transaction from a group's Privy server wallet on Base.
 * Used for vault redemptions, USDC transfers, and gas top-ups.
 */
async function sendGroupTransaction(
  privyWalletId: string,
  to: `0x${string}`,
  data: `0x${string}`,
): Promise<`0x${string}`> {
  const result = await privy().walletApi.ethereum.sendTransaction({
    walletId: privyWalletId,
    caip2: BASE_CAIP2,
    transaction: {
      to,
      value: "0x0",
      data,
    },
  });
  return result.hash as `0x${string}`;
}

/**
 * Send raw ETH from a group's Privy server wallet on Base.
 * Used for gas top-ups between wallets.
 */
export async function sendGroupEth(
  privyWalletId: string,
  to: `0x${string}`,
  valueWei: bigint,
): Promise<`0x${string}`> {
  const result = await privy().walletApi.ethereum.sendTransaction({
    walletId: privyWalletId,
    caip2: BASE_CAIP2,
    transaction: {
      to,
      value: `0x${valueWei.toString(16)}`,
      data: "0x",
    },
  });
  return result.hash as `0x${string}`;
}

/**
 * Helper: encode + send a contract call from a group wallet.
 */
export async function sendGroupContractCall(
  privyWalletId: string,
  contractAddress: `0x${string}`,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[],
): Promise<`0x${string}`> {
  const data = encodeFunctionData({
    abi: abi as any,
    functionName,
    args: [...args],
  });
  return sendGroupTransaction(privyWalletId, contractAddress, data);
}
