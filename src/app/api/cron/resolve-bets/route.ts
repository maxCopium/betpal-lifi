import "server-only";
import { timingSafeEqual } from "node:crypto";
import { errorResponse, HttpError } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { addBalanceEvent } from "@/lib/ledger";
import { resolveBetIfPossible, type ResolveResult } from "@/lib/resolveBet";
import { env } from "@/lib/env";

/**
 * GET/POST /api/cron/resolve-bets
 *
 * Auto-resolution cron. Finds every bet whose join_deadline has passed and
 * whose status is one of {open, locked, resolving}, then runs the same
 * `resolveBetIfPossible` code path the user-triggered route uses.
 *
 * Idempotent: payouts are keyed `payout:<betId>:<userId>` so re-running this
 * cron is safe. Bets that aren't yet settleable on Polymarket get bumped to
 * `resolving` and re-checked next tick.
 *
 * Auth: shared-secret via `Authorization: Bearer ${CRON_SECRET}`. Vercel Cron
 * sets this header automatically when wired in `vercel.json`. We accept GET
 * (Vercel default) and POST (manual triggers).
 *
 * Operational note: this is intentionally sequential — the bet count is small
 * and the Polymarket / DB writes are cheap. If we ever need parallelism we
 * can `Promise.allSettled` the inner loop, but errors per-bet are easier to
 * read in serial logs.
 */
async function handler(request: Request): Promise<Response> {
  try {
    const expected = env.cronSecret();
    if (!expected) {
      throw new HttpError(503, "CRON_SECRET not configured");
    }
    const auth = request.headers.get("authorization") ?? "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    // Constant-time comparison to prevent timing attacks on the cron secret.
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new HttpError(401, "invalid cron token");
    }

    const sb = supabaseService();
    const nowIso = new Date().toISOString();
    const { data: bets, error } = await sb
      .from("bets")
      .select("id")
      .in("status", ["open", "locked", "resolving"])
      .lt("join_deadline", nowIso)
      .limit(200);
    if (error) throw new HttpError(500, `bet scan failed: ${error.message}`);

    type CronOutcome = {
      betId: string;
      result?: ResolveResult;
      error?: string;
    };
    const outcomes: CronOutcome[] = [];
    let settled = 0;
    let resolving = 0;
    let noop = 0;
    let errored = 0;
    for (const row of bets ?? []) {
      const betId = row.id as string;
      try {
        const result = await resolveBetIfPossible(betId);
        outcomes.push({ betId, result });
        if (result.kind === "settled") settled++;
        else if (result.kind === "resolving") resolving++;
        else noop++;
      } catch (e) {
        errored++;
        outcomes.push({ betId, error: (e as Error).message });
        // keep going — one bad bet shouldn't block the rest
        console.warn(`cron: bet ${betId} failed:`, (e as Error).message);
      }
    }

    // ── Expire abandoned withdrawals ──────────────────────────────────
    // Withdrawals stuck in `pending` (no tx hash reported) for >24 hours
    // have their ledger reservation reversed so the user's balance unfreezes.
    const WITHDRAWAL_EXPIRY_MS = 24 * 60 * 60 * 1000;
    const expiryCutoff = new Date(Date.now() - WITHDRAWAL_EXPIRY_MS).toISOString();
    const { data: staleWithdrawals } = await sb
      .from("transactions")
      .select("id, group_id, user_id, amount_cents")
      .eq("type", "withdrawal")
      .eq("status", "pending")
      .is("tx_hash", null)
      .lt("created_at", expiryCutoff)
      .limit(100);

    let expiredCount = 0;
    for (const w of staleWithdrawals ?? []) {
      try {
        const cents = Number(w.amount_cents ?? 0);
        if (cents > 0) {
          await addBalanceEvent({
            groupId: w.group_id as string,
            userId: w.user_id as string,
            deltaCents: cents,
            reason: "adjustment",
            idempotencyKey: `withdrawal_expired:${w.id}`,
          });
        }
        await sb
          .from("transactions")
          .update({ status: "expired", updated_at: new Date().toISOString() })
          .eq("id", w.id)
          .eq("status", "pending"); // guard: only expire if still pending
        expiredCount++;
      } catch (e) {
        console.warn(`cron: expire withdrawal ${w.id} failed:`, (e as Error).message);
      }
    }

    return Response.json({
      scanned: bets?.length ?? 0,
      settled,
      resolving,
      noop,
      errored,
      expiredWithdrawals: expiredCount,
      outcomes,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export const GET = handler;
export const POST = handler;
