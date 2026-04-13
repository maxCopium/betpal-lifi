import "server-only";
import { warmSearchIndex } from "@/lib/polymarket";

export const maxDuration = 60;

/** GET /api/polymarket/warmup — pre-warm the search index (fire-and-forget). */
export async function GET(): Promise<Response> {
  try {
    const count = await warmSearchIndex();
    return Response.json({ indexed: count });
  } catch (e) {
    console.error("[polymarket/warmup] failed:", (e as Error).message);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
