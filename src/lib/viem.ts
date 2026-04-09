import "server-only";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { env } from "./env";

/**
 * Returns a viem PublicClient pointed at Base mainnet.
 *
 * Note: we don't memoize across calls because there are multiple viem
 * versions in the dep tree (privy/wagmi pull older ones) and TypeScript
 * can't reconcile a cached singleton's type with the freshly-created one.
 * createPublicClient is cheap; this is a fine trade-off.
 */
export function basePublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(env.baseRpcUrl()),
  });
}
