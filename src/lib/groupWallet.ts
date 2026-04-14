import "server-only";
import { PrivyClient } from "@privy-io/server-auth";
import { env } from "./env";
import { encodeFunctionData, parseGwei } from "viem";
import { BASE_CAIP2 } from "./constants";
import { basePublicClient } from "./viem";

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
 *
 * Explicitly sets EIP-1559 fee params from the current Base base fee.
 * Without this, Privy defaults `maxFeePerGas` very high, which makes the
 * chain demand `gasLimit × maxFeePerGas` upfront — that can be ~0.003+
 * ETH for a Composer tx, even though Base actually charges <$0.10.
 */
export async function sendGroupTransaction(
  privyWalletId: string,
  to: `0x${string}`,
  data: `0x${string}`,
  fromAddress?: `0x${string}`,
): Promise<`0x${string}`> {
  const pub = basePublicClient();
  // Estimate gas with a 25% buffer.
  let gasLimit: bigint;
  try {
    const est = await pub.estimateGas({
      account: fromAddress,
      to,
      data,
      value: BigInt(0),
    });
    gasLimit = (est * BigInt(125)) / BigInt(100);
  } catch {
    // Conservative fallback for Composer txs.
    gasLimit = BigInt(2_500_000);
  }

  // Base fee on Base mainnet is typically 0.001 – 0.05 gwei. Set
  // maxFeePerGas to baseFee * 2 + a small priority tip so the upfront
  // balance check stays small while still leaving headroom for spikes.
  const block = await pub.getBlock();
  const baseFee = block.baseFeePerGas ?? parseGwei("0.01");
  const priority = parseGwei("0.001");
  const maxFee = baseFee * BigInt(2) + priority;

  const result = await privy().walletApi.ethereum.sendTransaction({
    walletId: privyWalletId,
    caip2: BASE_CAIP2,
    transaction: {
      to,
      value: "0x0",
      data,
      gasLimit: `0x${gasLimit.toString(16)}`,
      maxFeePerGas: `0x${maxFee.toString(16)}`,
      maxPriorityFeePerGas: `0x${priority.toString(16)}`,
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
