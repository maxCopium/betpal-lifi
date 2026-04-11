import "server-only";
import { z } from "zod";
import { env } from "./env";

/**
 * Thin wrapper around the LI.FI Composer API.
 * Base URL: https://li.quest/v1
 *
 * Composer's keystone feature for BetPal: `/quote` accepts a vault token as
 * `toToken`, so a single quote routes "any chain → vault deposit on Base" in
 * one signature. Same for the reverse on payouts.
 */

const LIFI_BASE = "https://li.quest/v1";

/* ─── Chain & token info ─── */

export type LifiChain = {
  id: number;
  name: string;
  key: string;
  chainType: string;
  nativeToken: { symbol: string; decimals: number; address: string };
  logoURI?: string;
};

/** GET /v1/chains — all LI.FI-supported chains. Cached 5 min. */
export async function getChains(): Promise<LifiChain[]> {
  const res = await fetch(`${LIFI_BASE}/chains`, {
    headers: { accept: "application/json", "x-lifi-api-key": env.lifiApiKey() },
    next: { revalidate: 300 },
  });
  if (!res.ok) throw new Error(`LI.FI /chains failed: ${res.status}`);
  const json = (await res.json()) as { chains?: LifiChain[] };
  return json.chains ?? [];
}

export type LifiConnection = {
  fromChainId: number;
  toChainId: number;
  fromTokens: { address: string; symbol: string; decimals: number; logoURI?: string; priceUSD?: string }[];
  toTokens: { address: string; symbol: string; decimals: number }[];
};

/**
 * GET /v1/connections — which tokens can be routed between two chains.
 * Use to validate deposit routes exist before showing them in the UI.
 */
export async function getConnections(opts: {
  fromChain: number;
  toChain: number;
  toToken?: string;
}): Promise<LifiConnection[]> {
  const url = new URL(`${LIFI_BASE}/connections`);
  url.searchParams.set("fromChain", String(opts.fromChain));
  url.searchParams.set("toChain", String(opts.toChain));
  if (opts.toToken) url.searchParams.set("toToken", opts.toToken);
  const res = await fetch(url.toString(), {
    headers: { accept: "application/json", "x-lifi-api-key": env.lifiApiKey() },
    next: { revalidate: 300 },
  });
  if (!res.ok) throw new Error(`LI.FI /connections failed: ${res.status}`);
  const json = (await res.json()) as { connections?: LifiConnection[] };
  return json.connections ?? [];
}

export type LifiToken = {
  address: string;
  symbol: string;
  decimals: number;
  name: string;
  chainId: number;
  logoURI?: string;
  priceUSD?: string;
};

/** GET /v1/token — look up a single token's metadata + price. */
export async function getToken(opts: {
  chain: number;
  token: string;
}): Promise<LifiToken> {
  const url = new URL(`${LIFI_BASE}/token`);
  url.searchParams.set("chain", String(opts.chain));
  url.searchParams.set("token", opts.token);
  const res = await fetch(url.toString(), {
    headers: { accept: "application/json", "x-lifi-api-key": env.lifiApiKey() },
    next: { revalidate: 300 },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LI.FI /token failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

export type QuoteParams = {
  fromChain: number;
  toChain: number;
  fromToken: string;
  toToken: string;          // For deposits: the Morpho vault address on Base.
  fromAmount: string;       // base units (wei) as a string
  fromAddress: string;
  toAddress?: string;
  slippage?: number;        // 0..1, default 0.005
  integrator?: string;
};

const QuoteResponse = z
  .object({
    id: z.string(),
    transactionRequest: z
      .object({
        to: z.string(),
        data: z.string(),
        value: z.string().optional(),
        chainId: z.number().optional(),
        gasPrice: z.string().optional(),
        gasLimit: z.string().optional(),
      })
      .passthrough(),
    estimate: z
      .object({
        toAmount: z.string(),
        toAmountMin: z.string(),
        executionDuration: z.number().optional(),
      })
      .passthrough(),
    action: z.unknown(),
    includedSteps: z.unknown().optional(),
  })
  .passthrough();

export type LifiQuote = z.infer<typeof QuoteResponse>;

/** GET /quote — fetch a single Composer quote. */
export async function getComposerQuote(p: QuoteParams): Promise<LifiQuote> {
  const url = new URL(`${LIFI_BASE}/quote`);
  url.searchParams.set("fromChain", String(p.fromChain));
  url.searchParams.set("toChain", String(p.toChain));
  url.searchParams.set("fromToken", p.fromToken);
  url.searchParams.set("toToken", p.toToken);
  url.searchParams.set("fromAmount", p.fromAmount);
  url.searchParams.set("fromAddress", p.fromAddress);
  if (p.toAddress) url.searchParams.set("toAddress", p.toAddress);
  if (p.slippage !== undefined)
    url.searchParams.set("slippage", String(p.slippage));
  url.searchParams.set("integrator", p.integrator ?? env.lifiIntegrator());

  const res = await fetch(url.toString(), {
    headers: {
      accept: "application/json",
      "x-lifi-api-key": env.lifiApiKey(),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LI.FI /quote failed: ${res.status} ${body.slice(0, 500)}`);
  }
  const json = await res.json();
  return QuoteResponse.parse(json);
}

/**
 * GET /v1/quote/toAmount — reverse quote: specify the desired output amount
 * and get the required input amount. Useful for payouts ("I need exactly 50 USDC").
 */
export type ReverseQuoteParams = Omit<QuoteParams, "fromAmount"> & {
  toAmount: string; // desired output in base units
};

export async function getComposerReverseQuote(p: ReverseQuoteParams): Promise<LifiQuote> {
  const url = new URL(`${LIFI_BASE}/quote/toAmount`);
  url.searchParams.set("fromChain", String(p.fromChain));
  url.searchParams.set("toChain", String(p.toChain));
  url.searchParams.set("fromToken", p.fromToken);
  url.searchParams.set("toToken", p.toToken);
  url.searchParams.set("toAmount", p.toAmount);
  url.searchParams.set("fromAddress", p.fromAddress);
  if (p.toAddress) url.searchParams.set("toAddress", p.toAddress);
  if (p.slippage !== undefined) url.searchParams.set("slippage", String(p.slippage));
  url.searchParams.set("integrator", p.integrator ?? env.lifiIntegrator());

  const res = await fetch(url.toString(), {
    headers: { accept: "application/json", "x-lifi-api-key": env.lifiApiKey() },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LI.FI /quote/toAmount failed: ${res.status} ${body.slice(0, 500)}`);
  }
  return QuoteResponse.parse(await res.json());
}

/** GET /status — poll a Composer route's execution state. */
export async function getComposerStatus(opts: {
  txHash: string;
  fromChain: number;
  toChain: number;
}): Promise<{ status: string; substatus?: string; raw: unknown }> {
  const url = new URL(`${LIFI_BASE}/status`);
  url.searchParams.set("txHash", opts.txHash);
  url.searchParams.set("fromChain", String(opts.fromChain));
  url.searchParams.set("toChain", String(opts.toChain));
  const res = await fetch(url.toString(), {
    headers: { accept: "application/json", "x-lifi-api-key": env.lifiApiKey() },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LI.FI /status failed: ${res.status} ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as { status?: string; substatus?: string };
  return {
    status: json.status ?? "UNKNOWN",
    substatus: json.substatus,
    raw: json,
  };
}
