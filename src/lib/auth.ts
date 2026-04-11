import "server-only";
import { PrivyClient } from "@privy-io/server-auth";
import { env } from "./env";
import { supabaseService } from "./supabase";

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

  // Pull the linked wallet via the Privy server API. We need the embedded
  // wallet address for deposits and payouts, so it's not optional.
  const privyUser = await privy().getUser(claims.userId);
  const wallet = privyUser.linkedAccounts?.find(
    (a) => a.type === "wallet" && (a as { walletClientType?: string }).walletClientType === "privy",
  ) as { address?: string } | undefined;
  if (!wallet?.address) {
    throw new HttpError(400, "user has no linked wallet");
  }

  const sb = supabaseService();
  // Upsert by privy_id. ON CONFLICT DO UPDATE keeps wallet_address fresh.
  const { data, error } = await sb
    .from("users")
    .upsert(
      {
        privy_id: claims.userId,
        wallet_address: wallet.address.toLowerCase(),
      },
      { onConflict: "privy_id" },
    )
    .select("id, privy_id, wallet_address, display_name")
    .single();
  if (error || !data) {
    throw new HttpError(500, `user upsert failed: ${error?.message}`);
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
  console.error("[api] unhandled error", e);
  return Response.json(
    { error: (e as Error).message ?? "internal error" },
    { status: 500 },
  );
}
