import "server-only";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";

/**
 * GET /api/friends/search?q=<query>
 *
 * Trigram-fuzzy search across users by display_name / ens_name / basename.
 * Falls back to a wallet-address exact match if the query starts with `0x`.
 *
 * The schema declares pg_trgm GIN indexes on display_name / ens_name /
 * basename, so the `ilike` queries below are index-backed for non-trivial
 * substrings. The trigram operator is not exposed by the supabase-js builder,
 * so we use `ilike` which the trigram index also covers.
 *
 * Excludes the caller themselves.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const me = await requireUser(request);
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q || q.length < 2) {
      return Response.json({ users: [] });
    }

    const sb = supabaseService();

    // Wallet exact match (cheap; uses unique index).
    if (q.startsWith("0x") && q.length >= 6) {
      const { data, error } = await sb
        .from("users")
        .select("id, display_name, ens_name, basename, wallet_address")
        .ilike("wallet_address", `${q}%`)
        .neq("id", me.id)
        .limit(10);
      if (error) throw new HttpError(500, `wallet search failed: ${error.message}`);
      return Response.json({ users: data ?? [] });
    }

    // Escape PostgREST special chars to prevent filter injection via .or().
    // Commas and parens can break the .or() filter syntax; dots affect operators.
    const escaped = q.replace(/[\\%_]/g, "\\$&").replace(/[,().]/g, "");
    if (!escaped.trim()) return Response.json({ users: [] });
    const pattern = `%${escaped}%`;
    const { data, error } = await sb
      .from("users")
      .select("id, display_name, ens_name, basename, wallet_address")
      .or(
        `display_name.ilike.${pattern},ens_name.ilike.${pattern},basename.ilike.${pattern}`,
      )
      .neq("id", me.id)
      .limit(10);
    if (error) throw new HttpError(500, `friend search failed: ${error.message}`);
    return Response.json({ users: data ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
}
