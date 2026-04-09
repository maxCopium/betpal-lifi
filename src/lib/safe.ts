import "server-only";
import { env } from "./env";

/**
 * Safe (Gnosis) deployment wrapper for BetPal.
 *
 * Hard rules (do NOT relax):
 *   - Threshold M is at least 2.
 *   - Signers = group members + the app's resolver address (the +1).
 *   - The app key alone NEVER meets the threshold; M must be ≥ 2 and the app
 *     contributes only 1 signature, so it cannot move funds without ≥1 member.
 *   - Post-deployment we read the threshold + owners on-chain and assert.
 *
 * Counterfactual deployment is fine — we don't need an actual deploy until the
 * first state-changing tx. The Safe address is deterministic from
 * (initializer, salt).
 *
 * The actual @safe-global/protocol-kit calls are added on Day 2 when we wire
 * the group-creation flow. This file is the seam + the assertions.
 */

export type SafeConfigInputs = {
  groupId: string;
  memberAddresses: `0x${string}`[]; // EOAs of group members (Privy embedded wallets)
};

export type SafeConfigOutput = {
  owners: `0x${string}`[];
  threshold: number;
  saltNonce: string;
};

export function buildSafeConfig(inputs: SafeConfigInputs): SafeConfigOutput {
  const resolver = env.resolverAddress() as `0x${string}`;
  if (inputs.memberAddresses.length === 0) {
    throw new Error("Cannot build Safe config with zero members");
  }
  const seen = new Set<string>();
  const owners: `0x${string}`[] = [];
  for (const a of [...inputs.memberAddresses, resolver]) {
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    owners.push(a);
  }
  if (owners.length < 2) {
    throw new Error(
      "Safe config invariant violated: need at least 2 distinct owners (members + resolver)",
    );
  }
  // M = 2 minimum. For larger groups, scale to ceil(N/2)+1 (members) so the
  // resolver still cannot reach threshold without member co-signs.
  const memberCount = owners.length - 1;
  const memberMajority = Math.floor(memberCount / 2) + 1; // strict majority of members
  const threshold = Math.max(2, memberMajority);

  // saltNonce makes the counterfactual address deterministic per group
  const saltNonce = BigInt("0x" + sha256Hex(`betpal:group:${inputs.groupId}`))
    .toString();

  assertSafeInvariants({ owners, threshold });
  return { owners, threshold, saltNonce };
}

/** Run after fetching live owners/threshold from the chain post-deploy. */
export function assertSafeInvariants(cfg: {
  owners: `0x${string}`[];
  threshold: number;
}): void {
  if (cfg.threshold < 2) {
    throw new Error(
      `Safe threshold invariant violated: M=${cfg.threshold} (must be ≥ 2)`,
    );
  }
  const resolver = env.resolverAddress().toLowerCase();
  const hasResolver = cfg.owners.some((o) => o.toLowerCase() === resolver);
  if (!hasResolver) {
    throw new Error("Safe owners do not include app resolver address");
  }
  const memberCount = cfg.owners.length - 1;
  if (memberCount < 1) {
    throw new Error("Safe owners must contain at least 1 member + the resolver");
  }
  // Critical: app key must NOT meet threshold alone.
  // Since app contributes 1 signature and threshold ≥ 2, this is structurally
  // satisfied — but we assert it explicitly for clarity.
  const appAlone = 1;
  if (appAlone >= cfg.threshold) {
    throw new Error("Safe invariant violated: app key alone meets threshold");
  }
}

/** Tiny SHA-256 → hex helper using the global Web Crypto. */
function sha256Hex(input: string): string {
  // We're in a Node 20+ runtime; globalThis.crypto is available.
  const buf = new TextEncoder().encode(input);
  // synchronous fallback via node:crypto for non-browser runtimes
  // (Web Crypto subtle.digest is async; we want sync here for purity)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require("node:crypto") as typeof import("node:crypto");
  return nodeCrypto.createHash("sha256").update(buf).digest("hex");
}
