import "server-only";
import { errorResponse, requireUser } from "@/lib/auth";
import { trendingMarkets, getAllMockMarkets } from "@/lib/polymarket";

const DEMO_MODE = process.env.NEXT_PUBLIC_BETPAL_DEMO_MODE === "true";

/**
 * GET /api/polymarket/trending?limit=<n>
 *
 * Returns top markets by volume (active, not closed). Default 10.
 *
 * Demo mode: when NEXT_PUBLIC_BETPAL_DEMO_MODE=true, mock markets are
 * prepended to trending results. If the real API fails, only mocks are returned.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    await requireUser(request);
    const url = new URL(request.url);
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.min(20, Math.max(1, Number(limitParam))) : 10;

    const mockMarkets = DEMO_MODE ? getAllMockMarkets() : [];
    let realMarkets: Awaited<ReturnType<typeof trendingMarkets>> = [];
    try {
      realMarkets = await trendingMarkets(limit);
    } catch (e) {
      if (!DEMO_MODE) throw e;
    }

    const combined = [...mockMarkets, ...realMarkets].slice(0, limit);

    const projected = combined.map((m) => ({
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
