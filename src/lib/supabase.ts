import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

let _service: SupabaseClient | null = null;

/**
 * Server-side client using the service-role key. NEVER expose this to the
 * browser. Bypasses RLS — all auth checks must be done in route handlers
 * before calling this.
 */
export function supabaseService(): SupabaseClient {
  if (_service) return _service;
  _service = createClient(env.supabaseUrl(), env.supabaseSecretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _service;
}
