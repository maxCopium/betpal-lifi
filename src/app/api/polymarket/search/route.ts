import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { searchMarkets } from "@/lib/polymarket";

/**
 * GET /api/polymarket/search?q=<query>&limit=<n>
 *
 * Searches the polymarket_cache table (populated by /api/polymarket/warmup).
 * Instant even on cold starts — no Gamma API calls needed.
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

    // searchMarkets already returns the projected shape.
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
