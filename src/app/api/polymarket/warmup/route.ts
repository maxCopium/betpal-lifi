import "server-only";
import { errorResponse, requireUser } from "@/lib/auth";
import { warmSearchIndex } from "@/lib/polymarket";

export const maxDuration = 60;

/** GET /api/polymarket/warmup — pre-warm the search index (fire-and-forget). */
export async function GET(request: Request): Promise<Response> {
  try {
    await requireUser(request);
    const count = await warmSearchIndex();
    return Response.json({ indexed: count });
  } catch (e) {
    return errorResponse(e);
  }
}
