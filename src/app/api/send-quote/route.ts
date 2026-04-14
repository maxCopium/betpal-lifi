import "server-only";
import { z } from "zod";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { getComposerQuote } from "@/lib/composer";
import { BASE_CHAIN_ID, USDC_BASE } from "@/lib/constants";

/**
 * POST /api/send-quote
 *
 * Peer-to-peer wallet send. Thin wrapper around LI.FI `/quote` with
 * `toAddress` set to the recipient so USDC lands directly in their
 * wallet. No DB writes — this bypasses the group vault entirely.
 *
 * Same-chain Base USDC→USDC sends do NOT go through this endpoint:
 * the frontend constructs a direct ERC-20 transfer for those (no gas
 * on LI.FI fees). This route is only hit for cross-chain / non-USDC
 * sources where we need Composer routing.
 *
 * Security: requires a valid bearer token. fromAddress must match the
 * caller's own wallet — we never construct a quote for someone else's
 * address. toAddress is taken verbatim (recipient is a group member's
 * self-custody wallet the caller looked up client-side).
 */
const SendQuoteBody = z.object({
  fromChain: z.number().int().positive(),
  fromToken: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  fromAmount: z.string().regex(/^\d+$/),
  toAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const me = await requireUser(request);
    const json = await request.json().catch(() => {
      throw new HttpError(400, "invalid json body");
    });
    const body = SendQuoteBody.parse(json);

    const quote = await getComposerQuote({
      fromChain: body.fromChain,
      toChain: BASE_CHAIN_ID,
      fromToken: body.fromToken,
      toToken: USDC_BASE,
      fromAmount: body.fromAmount,
      fromAddress: me.walletAddress,
      toAddress: body.toAddress,
      slippage: 0.005,
    });

    return Response.json({ quote });
  } catch (e) {
    return errorResponse(e);
  }
}
