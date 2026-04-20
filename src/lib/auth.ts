import "server-only";
import { PrivyClient } from "@privy-io/server-auth";
import { env } from "./env";
import { supabaseService } from "./supabase";

const ADJECTIVES = [
  "Swift", "Bold", "Lucky", "Chill", "Witty", "Brave", "Slick", "Keen",
  "Sharp", "Cool", "Wild", "Calm", "Sly", "Rad", "Deft", "Mint",
];
const NOUNS = [
  "Ape", "Fox", "Owl", "Wolf", "Bear", "Hawk", "Shark", "Tiger",
  "Whale", "Bull", "Cat", "Panda", "Moose", "Otter", "Crow", "Lynx",
];

function generateUsername(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 100);
  return `${adj}${noun}${num}`;
}

let _privy: PrivyClient | null = null;
function privy(): PrivyClient {
  if (_privy) return _privy;
  _privy = new PrivyClient(env.privyAppId(), env.privyAppSecret());
  return _privy;
}

export type AuthedUser = {
  id: string;            // BetPal users.id (uuid)
  privyId: string;
  walletAddress: string;
  displayName: string | null;
};

/**
 * Resolve the caller from an Authorization: Bearer <privy-access-token> header.
 * Throws on missing/invalid token. Always upserts a row in `users` keyed by
 * privy_id so subsequent foreign keys work.
 */
export async function requireUser(req: Request): Promise<AuthedUser> {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new HttpError(401, "missing bearer token");
  const token = m[1];

  let claims;
  try {
    claims = await privy().verifyAuthToken(token);
  } catch (e) {
    throw new HttpError(401, `invalid token: ${(e as Error).message}`);
  }

  // Pull the linked wallet via the Privy server API. We need a wallet
  // address for deposits and payouts, so it's not optional — but any
  // linked wallet works (embedded Privy wallet preferred, external
  // wallets like MetaMask fall back cleanly).
  const privyUser = await privy().getUser(claims.userId);
  const wallets = (privyUser.linkedAccounts ?? []).filter(
    (a) => a.type === "wallet",
  ) as Array<{ address?: string; walletClientType?: string }>;
  // Prefer the Privy-embedded wallet if present, else take any linked wallet.
  const wallet =
    wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
  if (!wallet?.address) {
    throw new HttpError(
      400,
      "user has no linked wallet — sign out and sign back in, or link a wallet in your account",
    );
  }

  const sb = supabaseService();
  // Check if user already exists — upsert would overwrite display_name.
  const { data: existing } = await sb
    .from("users")
    .select("id, privy_id, wallet_address, display_name")
    .eq("privy_id", claims.userId)
    .maybeSingle();

  let data;
  if (existing) {
    // Existing user — only update wallet_address (keep display_name).
    const { data: updated, error } = await sb
      .from("users")
      .update({ wallet_address: wallet.address.toLowerCase() })
      .eq("privy_id", claims.userId)
      .select("id, privy_id, wallet_address, display_name")
      .single();
    if (error || !updated) throw new HttpError(500, `user update failed: ${error?.message}`);
    data = updated;
  } else {
    // New user — insert with a random display_name.
    const { data: inserted, error } = await sb
      .from("users")
      .insert({
        privy_id: claims.userId,
        wallet_address: wallet.address.toLowerCase(),
        display_name: generateUsername(),
      })
      .select("id, privy_id, wallet_address, display_name")
      .single();
    if (error || !inserted) throw new HttpError(500, `user insert failed: ${error?.message}`);
    data = inserted;
  }

  return {
    id: data.id as string,
    privyId: data.privy_id as string,
    walletAddress: data.wallet_address as string,
    displayName: (data.display_name as string | null) ?? null,
  };
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  const msg = e instanceof Error ? e.message : String(e);
  console.error("[api] unhandled error", msg);
  // Surface the error message so the client can show what went wrong.
  return Response.json({ error: msg }, { status: 500 });
}
