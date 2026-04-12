import "server-only";
import { z } from "zod";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { getMarket, isMockMarket, getMockMarketData } from "@/lib/polymarket";
import { resolveBetIfPossible } from "@/lib/resolveBet";

/**
 * POST /api/groups/[id]/bets
 *
 * Create a new bet for a group, anchored to a Polymarket market id.
 * Polymarket is the ORACLE only — we never trade on it. We pull the question
 * + outcomes + endDate so the bet is self-contained for display and so we
 * can compute join/resolution deadlines without re-fetching every time.
 *
 * Constraints (locked decisions):
 *   - join_deadline must be < polymarket end date (you can't join a bet
 *     after the underlying market resolves)
 *   - max_resolution_date is bounded; we accept caller input but cap it at
 *     polymarket end + 14 days (UMA dispute + slack)
 *   - status starts as `open`
 *
 * GET /api/groups/[id]/bets
 *
 * List bets for a group (any status). Caller must be a member.
 *
 * Per Next 16 conventions, `params` is a Promise and must be awaited.
 */

const CreateBody = z.object({
  polymarket_market_id: z.string().min(1),
  /** Optional override; if absent we use the market's `question`. */
  title: z.string().trim().min(1).max(200).optional(),
  /** ISO timestamp; must be in the future and before the market end. */
  join_deadline: z.string().datetime().optional(),
  /** Fixed stake amount in cents that every participant must pay. */
  stake_amount_cents: z.number().int().min(100).max(1_000_000), // $1 – $10,000
  /** Optional cap on how many people can join. */
  max_participants: z.number().int().min(2).max(100).optional(),
  /** If true and max_participants is set, bet locks when all slots fill. */
  start_when_full: z.boolean().optional().default(false),
});

const MAX_RESOLUTION_BUFFER_MS = 14 * 24 * 60 * 60 * 1000;

function parseStringArray(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId } = await params;
    const json = await request.json().catch(() => {
      throw new HttpError(400, "invalid json body");
    });
    const body = CreateBody.parse(json);

    const sb = supabaseService();
    const { data: membership, error: memErr } = await sb
      .from("group_members")
      .select("user_id")
      .eq("group_id", groupId)
      .eq("user_id", me.id)
      .maybeSingle();
    if (memErr) throw new HttpError(500, `member check failed: ${memErr.message}`);
    if (!membership) throw new HttpError(403, "not a member of this group");

    // Pull the market from Polymarket. Side effect: cache it for later
    // resolution checks so we don't hit Gamma every poll.
    let market;
    try {
      market = await getMarket(body.polymarket_market_id);
    } catch (e) {
      throw new HttpError(400, `polymarket lookup failed: ${(e as Error).message}`);
    }

    const outcomes = parseStringArray(market.outcomes);
    if (!outcomes || outcomes.length < 2) {
      throw new HttpError(400, "market does not expose at least 2 outcomes");
    }

    if (!market.endDate) {
      throw new HttpError(400, "market has no endDate; cannot bound resolution");
    }
    const marketEnd = new Date(market.endDate).getTime();
    const now = Date.now();

    // If start_when_full with no explicit deadline, use market end as fallback deadline.
    const startWhenFull = body.start_when_full && body.max_participants != null;
    let joinDeadline: number;
    if (body.join_deadline) {
      joinDeadline = new Date(body.join_deadline).getTime();
      if (joinDeadline <= now) throw new HttpError(400, "join_deadline must be in the future");
      if (joinDeadline >= marketEnd) {
        throw new HttpError(400, "join_deadline must be before the market end");
      }
    } else if (startWhenFull) {
      // No explicit deadline — use market end as upper bound.
      joinDeadline = marketEnd;
    } else {
      throw new HttpError(400, "join_deadline is required unless start_when_full is set with max_participants");
    }
    const maxResolution = new Date(marketEnd + MAX_RESOLUTION_BUFFER_MS).toISOString();

    // Best-effort cache write — don't fail bet creation if cache write fails.
    await sb.from("polymarket_markets_cache").upsert({
      market_id: body.polymarket_market_id,
      payload_json: market,
      last_synced: new Date().toISOString(),
    });

    const polymarketUrl = market.slug
      ? `https://polymarket.com/event/${market.slug}`
      : `https://polymarket.com/market/${body.polymarket_market_id}`;

    const { data: bet, error: insertErr } = await sb
      .from("bets")
      .insert({
        group_id: groupId,
        creator_id: me.id,
        polymarket_market_id: body.polymarket_market_id,
        polymarket_url: polymarketUrl,
        title: body.title ?? market.question,
        question: market.question,
        options: outcomes,
        stake_amount_cents: body.stake_amount_cents,
        join_deadline: new Date(joinDeadline).toISOString(),
        max_resolution_date: maxResolution,
        max_participants: body.max_participants ?? null,
        start_when_full: startWhenFull,
        status: "open",
      })
      .select(
        "id, group_id, title, options, stake_amount_cents, polymarket_market_id, polymarket_url, join_deadline, max_resolution_date, status, created_at",
      )
      .single();
    if (insertErr || !bet) {
      throw new HttpError(500, `bet insert failed: ${insertErr?.message}`);
    }
    return Response.json(bet, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId } = await params;

    const sb = supabaseService();
    const { data: membership, error: memErr } = await sb
      .from("group_members")
      .select("user_id")
      .eq("group_id", groupId)
      .eq("user_id", me.id)
      .maybeSingle();
    if (memErr) throw new HttpError(500, `member check failed: ${memErr.message}`);
    if (!membership) throw new HttpError(403, "not a member of this group");

    const { data, error } = await sb
      .from("bets")
      .select(
        "id, title, options, stake_amount_cents, polymarket_market_id, polymarket_url, join_deadline, max_resolution_date, status, resolution_outcome, created_at",
      )
      .eq("group_id", groupId)
      .order("created_at", { ascending: false });
    if (error) throw new HttpError(500, `bet list failed: ${error.message}`);

    // Lazy resolution: fire-and-forget for any past-deadline bets
    const now = new Date();
    const resolvableStatuses = ["open", "locked", "resolving"];
    for (const b of data ?? []) {
      if (
        resolvableStatuses.includes(b.status as string) &&
        new Date(b.join_deadline as string) < now
      ) {
        resolveBetIfPossible(b.id as string).catch((err) =>
          console.warn(`lazy resolve bet ${b.id} failed:`, err.message),
        );
      }
    }

    // Enrich with live Polymarket prices (best-effort, parallel)
    const bets = data ?? [];
    const enriched = await Promise.all(
      bets.map(async (b) => {
        try {
          const mid = b.polymarket_market_id as string;
          let outcomes: string[] | null = null;
          let prices: number[] = [];
          if (isMockMarket(mid)) {
            const mock = getMockMarketData(mid);
            if (mock) {
              outcomes = parseStringArray(mock.outcomes);
              prices = (parseStringArray(mock.outcomePrices) ?? []).map(Number);
            }
          } else {
            const m = await getMarket(mid);
            outcomes = parseStringArray(m.outcomes);
            prices = (parseStringArray(m.outcomePrices) ?? []).map(Number);
          }
          return { ...b, live_prices: outcomes && prices.length ? Object.fromEntries(outcomes.map((o, i) => [o, prices[i]])) : null };
        } catch {
          return { ...b, live_prices: null };
        }
      }),
    );

    return Response.json({ bets: enriched });
  } catch (e) {
    return errorResponse(e);
  }
}
