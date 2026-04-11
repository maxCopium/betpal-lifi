import "server-only";
import { keccak256, toBytes, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { env } from "./env";

/**
 * Per-group custodial wallet derivation.
 *
 * Each group gets a deterministic EOA derived from:
 *   privateKey = keccak256(resolverPrivateKey + groupId)
 *
 * The resolver key is the master secret; per-group keys are isolated so a
 * compromise of one group wallet doesn't leak others (without the master).
 *
 * Security note: the app holds all keys. Acceptable for hackathon / demo
 * amounts. Production would use a KMS or multisig.
 */

export function deriveGroupWallet(groupId: string) {
  const resolverKey = env.resolverPrivateKey();
  const derived = keccak256(toBytes(resolverKey + groupId));
  const account = privateKeyToAccount(derived);
  return { address: account.address, account, privateKey: derived };
}

/**
 * Create a viem WalletClient for a group's derived wallet on Base.
 * Used for vault redemptions, USDC transfers, and gas top-ups.
 */
export function groupWalletClient(groupId: string) {
  const { account } = deriveGroupWallet(groupId);
  return createWalletClient({
    account,
    chain: base,
    transport: http(env.baseRpcUrl()),
  });
}
