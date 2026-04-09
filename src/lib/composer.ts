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
