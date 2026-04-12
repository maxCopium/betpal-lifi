import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { searchMarkets } from "@/lib/polymarket";

/**
 * GET /api/polymarket/search?q=<query>&limit=<n>
 *
 * Thin proxy in front of Polymarket's Gamma /markets endpoint. We do this on
 * the server (rather than calling Gamma directly from the browser) for two
 * reasons:
 *
 *   1. The endpoint is rate-limited and we want a single egress identity.
 *   2. We can layer caching + filtering later (e.g. drop archived markets,
 *      drop markets without binary outcomes) without touching every caller.
 *
 * Auth: caller must be a signed-in user. Search is read-only but Polymarket
 * data is the substrate of every bet, so we gate it behind the same auth
 * boundary as the rest of the API.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    await requireUser(request);
    const url = new URL(request.url);
    const q = url.searchParams.get("q") ?? "";
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.min(50, Math.max(1, Number(limitParam))) : 20;
    if (limitParam && Number.isNaN(Number(limitParam))) {
      throw new HttpError(400, "limit must be a number");
    }

    const markets = await searchMarkets(q, limit);

    // Project to a small, stable shape so the UI doesn't depend on Gamma's
    // full passthrough payload.
    const projected = markets.map((m) => ({
      id: m.id,
      question: m.question,
      slug: m.slug ?? null,
      end_date: m.endDate ?? null,
      closed: !!m.closed,
      active: m.active ?? null,
    }));
    return Response.json({ markets: projected });
  } catch (e) {
    return errorResponse(e);
  }
}
