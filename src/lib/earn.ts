import "server-only";
import { z } from "zod";

/**
 * LI.FI Earn API wrapper. No auth required.
 *
 * For BetPal v1 we only need:
 *   - vault discovery (Morpho USDC on Base) → resolves the vault address +
 *     deposit token + apy snapshot.
 *   - portfolio reads (a wallet's holdings across LI.FI-indexed vaults) for
 *     the dashboard "yield earned" line.
 *
 * The exact endpoint shape is finalized on Day 0 with a real curl. The wrapper
 * here is the integration seam — once Day 0 confirms shapes, fill in the URLs.
 */

const EARN_BASE = "https://earn.li.fi"; // placeholder; verify Day 0

const VaultSchema = z
  .object({
    address: z.string(),
    chainId: z.number(),
    name: z.string().optional(),
    protocol: z.string().optional(),
    asset: z.object({
      address: z.string(),
      symbol: z.string(),
      decimals: z.number(),
    }),
    apy: z.number().optional(),
    tvlUsd: z.number().optional(),
  })
  .passthrough();

export type EarnVault = z.infer<typeof VaultSchema>;

/**
 * Find the Morpho USDC vault on Base.
 * Day 0: pin the address into env (`MORPHO_USDC_VAULT_BASE`) so we don't
 * depend on this list at runtime. This function still exists for the
 * write-up's "Earn API used for vault discovery" claim and for the dashboard.
 */
export async function listVaults(opts: {
  chainId?: number;
  protocol?: string;
  asset?: string;
}): Promise<EarnVault[]> {
  const url = new URL(`${EARN_BASE}/vaults`);
  if (opts.chainId) url.searchParams.set("chainId", String(opts.chainId));
  if (opts.protocol) url.searchParams.set("protocol", opts.protocol);
  if (opts.asset) url.searchParams.set("asset", opts.asset);
  const res = await fetch(url.toString(), {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Earn /vaults failed: ${res.status} ${body.slice(0, 500)}`,
    );
  }
  const json = await res.json();
  // Earn often returns { vaults: [...] }; tolerate either shape.
  const arr = Array.isArray(json) ? json : (json.vaults ?? json.data ?? []);
  return z.array(VaultSchema).parse(arr);
}

/** Read a wallet's positions across Earn-indexed vaults. */
export async function getPortfolio(walletAddress: string): Promise<unknown> {
  const url = new URL(`${EARN_BASE}/portfolio/${walletAddress}`);
  const res = await fetch(url.toString(), {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Earn /portfolio failed: ${res.status} ${body.slice(0, 500)}`,
    );
  }
  return res.json();
}
