import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/auth";
import { env } from "@/lib/env";
import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
} from "viem";
import { base, mainnet, polygon, arbitrum, optimism } from "viem/chains";

/**
 * GET /api/wallet/holdings?address=0x...
 *
 * Fetches the user's non-zero token balances across multiple chains.
 * Uses LI.FI /v1/tokens for the token list, then viem multicall per chain
 * for actual balances (LI.FI has no working balance REST endpoint).
 *
 * Returns holdings sorted by USD value — used for "Pay from" selector.
 */

export const maxDuration = 30;

const LIFI_BASE = "https://li.quest/v1";

const CHAINS = [
  { id: 8453, name: "Base", chain: base },
  { id: 1, name: "Ethereum", chain: mainnet },
  { id: 137, name: "Polygon", chain: polygon },
  { id: 42161, name: "Arbitrum", chain: arbitrum },
  { id: 10, name: "Optimism", chain: optimism },
] as const;

type TokenInfo = {
  address: string;
  symbol: string;
  decimals: number;
  name: string;
  logoURI?: string;
  priceUSD?: string;
};

export type Holding = {
  chainId: number;
  chainName: string;
  token: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;
  balanceFormatted: string;
  logoURI?: string;
  priceUSD?: string;
  valueUSD: number;
};

/** Fetch top tokens for multiple chains from LI.FI in one request */
async function getLifiTokens(
  chainIds: readonly number[],
): Promise<Record<number, TokenInfo[]>> {
  try {
    const res = await fetch(
      `${LIFI_BASE}/tokens?chains=${chainIds.join(",")}&minPriceUSD=0.10`,
      {
        headers: {
          accept: "application/json",
          "x-lifi-api-key": env.lifiApiKey(),
        },
        next: { revalidate: 300 },
      },
    );
    if (!res.ok) return {};
    const json = (await res.json()) as {
      tokens: Record<string, TokenInfo[]>;
    };
    const result: Record<number, TokenInfo[]> = {};
    for (const cid of chainIds) {
      result[cid] = json.tokens?.[String(cid)] ?? [];
    }
    return result;
  } catch {
    return {};
  }
}

/** Check balances for a wallet on one chain via viem multicall */
async function checkBalancesOnChain(
  chainDef: (typeof CHAINS)[number],
  wallet: `0x${string}`,
  tokens: TokenInfo[],
): Promise<Holding[]> {
  const rpcUrl =
    chainDef.id === 8453
      ? env.baseRpcUrl()
      : undefined; // use default public RPC for other chains

  const client = createPublicClient({
    chain: chainDef.chain,
    transport: http(rpcUrl),
  });

  const holdings: Holding[] = [];

  // Native balance
  try {
    const nativeBal = await client.getBalance({ address: wallet });
    if (nativeBal > BigInt(0)) {
      const nativeToken = tokens.find(
        (t) => t.address === "0x0000000000000000000000000000000000000000",
      );
      const formatted = formatUnits(nativeBal, 18);
      const price = Number(nativeToken?.priceUSD ?? 0);
      const valueUSD = price * Number(formatted);
      if (valueUSD >= 0.01) {
        holdings.push({
          chainId: chainDef.id,
          chainName: chainDef.name,
          token: "0x0000000000000000000000000000000000000000",
          symbol: nativeToken?.symbol ?? "ETH",
          name: nativeToken?.name ?? "Native",
          decimals: 18,
          balance: nativeBal.toString(),
          balanceFormatted: formatted,
          logoURI: nativeToken?.logoURI,
          priceUSD: nativeToken?.priceUSD,
          valueUSD,
        });
      }
    }
  } catch (e) { console.warn(`[holdings] native balance failed on ${chainDef.name}:`, (e as Error).message); }

  // ERC-20 balances via multicall
  const erc20s = tokens
    .filter((t) => t.address !== "0x0000000000000000000000000000000000000000")
    .slice(0, 20); // cap to keep fast

  if (erc20s.length === 0) return holdings;

  try {
    const calls = erc20s.map((t) => ({
      address: getAddress(t.address) as `0x${string}`,
      abi: erc20Abi,
      functionName: "balanceOf" as const,
      args: [wallet] as const,
    }));

    const results = await client.multicall({ contracts: calls });

    for (let i = 0; i < erc20s.length; i++) {
      const result = results[i];
      if (result.status !== "success") continue;
      const raw = result.result as bigint;
      if (raw <= BigInt(0)) continue;

      const t = erc20s[i];
      const formatted = formatUnits(raw, t.decimals);
      const valueUSD = Number(t.priceUSD ?? 0) * Number(formatted);
      if (valueUSD < 0.01) continue;

      holdings.push({
        chainId: chainDef.id,
        chainName: chainDef.name,
        token: t.address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        balance: raw.toString(),
        balanceFormatted: formatted,
        logoURI: t.logoURI,
        priceUSD: t.priceUSD,
        valueUSD,
      });
    }
  } catch (e) { console.warn(`[holdings] multicall failed on ${chainDef.name}:`, (e as Error).message); }

  return holdings;
}

export async function GET(req: NextRequest) {
  try {
    const me = await requireUser(req);
    const address = req.nextUrl.searchParams.get("address");
    if (!address || !isAddress(address)) {
      return NextResponse.json({ error: "invalid address" }, { status: 400 });
    }
    const wallet = getAddress(address) as `0x${string}`;
    if (wallet.toLowerCase() !== me.walletAddress.toLowerCase()) {
      return NextResponse.json(
        { error: "can only query your own wallet" },
        { status: 403 },
      );
    }

    console.log(`[holdings] fetching for wallet ${wallet}`);
    // 1) Fetch token lists for all chains from LI.FI (single request)
    const allTokens = await getLifiTokens(CHAINS.map((c) => c.id));
    console.log(`[holdings] LI.FI tokens loaded: ${Object.entries(allTokens).map(([k, v]) => `${k}=${(v as any[]).length}`).join(", ")}`);

    // 2) Check balances across all chains in parallel. Per-chain 6s timeout
    //    so one slow public RPC can't wedge the whole request past Vercel's
    //    10s gateway limit — that's the 504 people see.
    const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
      ]);

    const chainResults = await Promise.all(
      CHAINS.map((chainDef) => {
        const tokens = allTokens[chainDef.id] ?? [];
        const sorted = [...tokens].sort(
          (a, b) => Number(b.priceUSD ?? 0) - Number(a.priceUSD ?? 0),
        );
        return withTimeout(
          checkBalancesOnChain(chainDef, wallet, sorted),
          6000,
          [] as Holding[],
        ).catch((e) => {
          console.warn(`[holdings] ${chainDef.name} failed: ${(e as Error).message}`);
          return [] as Holding[];
        });
      }),
    );

    const allHoldings = chainResults.flat();
    allHoldings.sort((a, b) => b.valueUSD - a.valueUSD);
    console.log(`[holdings] found ${allHoldings.length} tokens: ${allHoldings.map(h => `${h.symbol}@${h.chainName}`).join(", ")}`);

    return NextResponse.json({ holdings: allHoldings });
  } catch (err) {
    return errorResponse(err);
  }
}
