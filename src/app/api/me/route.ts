import "server-only";
import { z } from "zod";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";

/**
 * GET  /api/me — current user profile
 * PATCH /api/me — update display_name
 */

const PatchBody = z.object({
  display_name: z.string().trim().min(1).max(30),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const me = await requireUser(request);
    const sb = supabaseService();
    const { data, error } = await sb
      .from("users")
      .select("id, display_name, ens_name, basename, wallet_address")
      .eq("id", me.id)
      .single();
    if (error || !data) throw new HttpError(500, `user lookup failed: ${error?.message}`);
    return Response.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const me = await requireUser(request);
    const json = await request.json().catch(() => {
      throw new HttpError(400, "invalid json body");
    });
    const body = PatchBody.parse(json);

    const sb = supabaseService();
    const { data, error } = await sb
      .from("users")
      .update({ display_name: body.display_name, updated_at: new Date().toISOString() })
      .eq("id", me.id)
      .select("id, display_name, wallet_address")
      .single();
    if (error || !data) throw new HttpError(500, `update failed: ${error?.message}`);
    return Response.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}
