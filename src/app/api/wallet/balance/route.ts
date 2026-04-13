import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { basePublicClient } from "@/lib/viem";
import { erc20Abi, formatUnits, getAddress, isAddress } from "viem";
import { BASE_CHAIN_ID, USDC_BASE } from "@/lib/constants";

/**
 * GET /api/wallet/balance?address=0x...
 *
 * 1. Fetches supported tokens on Base from LI.FI /v1/tokens  (LI.FI integration)
 * 2. Reads native ETH balance + top ERC-20 balances via viem multicall
 *    (LI.FI has no balance REST endpoint — their own MCP tool uses Multicall3)
 * 3. Returns all non-zero balances.
 */

const LIFI_BASE = "https://li.quest/v1";

// Well-known stablecoins & majors on Base to always check
const PRIORITY_TOKENS = [
  USDC_BASE,                                      // USDC
  "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // DAI
  "0x4200000000000000000000000000000000000006", // WETH
  "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC
  "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
];

type TokenInfo = {
  address: string;
  symbol: string;
  decimals: number;
  name: string;
  logoURI?: string;
  priceUSD?: string;
};

/** Fetch top tokens on Base from LI.FI */
async function getLifiTokens(): Promise<TokenInfo[]> {
  try {
    const res = await fetch(
      `${LIFI_BASE}/tokens?chains=${BASE_CHAIN_ID}&minPriceUSD=0.01`,
      {
        headers: {
          accept: "application/json",
          "x-lifi-api-key": env.lifiApiKey(),
        },
        next: { revalidate: 300 }, // cache 5 min
      },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as {
      tokens: Record<string, TokenInfo[]>;
    };
    return json.tokens?.[String(BASE_CHAIN_ID)] ?? [];
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  try {
  const me = await requireUser(req);
  const address = req.nextUrl.searchParams.get("address");
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }
  // Only allow querying the caller's own wallet address.
  const wallet = getAddress(address);
  if (wallet.toLowerCase() !== me.walletAddress.toLowerCase()) {
    return NextResponse.json({ error: "can only query your own wallet" }, { status: 403 });
  }

  // 1) Get token list from LI.FI
  const lifiTokens = await getLifiTokens();

  // Build a de-duped set of tokens to check (priority + top LI.FI tokens)
  const tokenMap = new Map<string, TokenInfo>();
  for (const addr of PRIORITY_TOKENS) {
    const lower = addr.toLowerCase();
    const found = lifiTokens.find((t) => t.address.toLowerCase() === lower);
    if (found) tokenMap.set(lower, found);
    else
      tokenMap.set(lower, {
        address: addr,
        symbol: "???",
        decimals: 18,
        name: "",
      });
  }
  // Add top LI.FI tokens by price (cap at 20 total)
  const sorted = [...lifiTokens].sort(
    (a, b) => Number(b.priceUSD ?? 0) - Number(a.priceUSD ?? 0),
  );
  for (const t of sorted) {
    if (tokenMap.size >= 20) break;
    const lower = t.address.toLowerCase();
    if (!tokenMap.has(lower)) tokenMap.set(lower, t);
  }

  const tokens = [...tokenMap.values()];
  const client = basePublicClient();

  // 2) Multicall: native balance + all ERC-20 balanceOf
  const calls = tokens.map((t) => ({
    address: getAddress(t.address) as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf" as const,
    args: [wallet] as const,
  }));

  const [nativeBal, erc20Results] = await Promise.all([
    client.getBalance({ address: wallet }),
    client.multicall({ contracts: calls }),
  ]);

  // 3) Build response — only non-zero balances
  const balances: {
    symbol: string;
    name: string;
    address: string;
    balance: string;
    balanceFormatted: string;
    decimals: number;
    logoURI?: string;
    priceUSD?: string;
  }[] = [];

  // Native ETH
  if (nativeBal > BigInt(0)) {
    balances.push({
      symbol: "ETH",
      name: "Ethereum",
      address: "0x0000000000000000000000000000000000000000",
      balance: nativeBal.toString(),
      balanceFormatted: formatUnits(nativeBal, 18),
      decimals: 18,
      priceUSD: lifiTokens.find(
        (t) =>
          t.address.toLowerCase() ===
          "0x0000000000000000000000000000000000000000",
      )?.priceUSD,
    });
  }

  // ERC-20s
  for (let i = 0; i < tokens.length; i++) {
    const result = erc20Results[i];
    if (result.status !== "success") continue;
    const raw = result.result as bigint;
    if (raw === BigInt(0)) continue;
    const t = tokens[i];
    balances.push({
      symbol: t.symbol,
      name: t.name,
      address: t.address,
      balance: raw.toString(),
      balanceFormatted: formatUnits(raw, t.decimals),
      decimals: t.decimals,
      logoURI: t.logoURI,
      priceUSD: t.priceUSD,
    });
  }

  // Sort: stablecoins first (by USD value), then rest
  balances.sort((a, b) => {
    const aVal =
      Number(a.priceUSD ?? 0) * Number(a.balanceFormatted);
    const bVal =
      Number(b.priceUSD ?? 0) * Number(b.balanceFormatted);
    return bVal - aVal;
  });

  return NextResponse.json({ balances, source: "lifi-tokens+multicall" });
  } catch (err) {
    return errorResponse(err);
  }
}
