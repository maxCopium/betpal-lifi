import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { searchMarkets, getAllMockMarkets } from "@/lib/polymarket";

const DEMO_MODE = process.env.NEXT_PUBLIC_BETPAL_DEMO_MODE === "true";

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
 *
 * Demo mode: when NEXT_PUBLIC_BETPAL_DEMO_MODE=true, mock markets are
 * prepended to results. If the real API fails, only mocks are returned.
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

    // In demo mode, prepend mock markets. If real API fails, return mocks only.
    const mockMarkets = DEMO_MODE ? getAllMockMarkets() : [];
    let realMarkets: Awaited<ReturnType<typeof searchMarkets>> = [];
    try {
      realMarkets = await searchMarkets(q, limit);
    } catch (e) {
      if (!DEMO_MODE) throw e;
      // In demo mode, swallow the error — mocks are enough.
    }

    const combined = [...mockMarkets, ...realMarkets].slice(0, limit);

    // Project to a small, stable shape so the UI doesn't depend on Gamma's
    // full passthrough payload.
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
