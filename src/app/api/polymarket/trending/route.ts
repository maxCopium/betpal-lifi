import "server-only";
import { errorResponse, requireUser } from "@/lib/auth";
import { trendingMarkets } from "@/lib/polymarket";

/**
 * GET /api/polymarket/trending?limit=<n>
 *
 * Returns top markets by volume (active, not closed). Default 10.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    await requireUser(request);
    const url = new URL(request.url);
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.min(20, Math.max(1, Number(limitParam))) : 10;

    const markets = await trendingMarkets(limit);

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
