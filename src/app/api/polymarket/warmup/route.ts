import "server-only";
import { warmSearchIndex } from "@/lib/polymarket";

export const maxDuration = 60;

/** GET /api/polymarket/warmup — pre-warm the search index (fire-and-forget). */
export async function GET(): Promise<Response> {
  const count = await warmSearchIndex();
  return Response.json({ indexed: count });
}
