import "server-only";
import { z } from "zod";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { createGroupWallet } from "@/lib/groupWallet";
import { bestUsdcVaultOnBase } from "@/lib/earn";
import { BASE_CHAIN_ID } from "@/lib/constants";

/**
 * POST /api/groups
 *
 * Create a new betting group. Caller is the implicit owner. Other members
 * must already be BetPal users (looked up by their BetPal `users.id`).
 *
 * Flow:
 *   1. Authenticate caller (requireUser).
 *   2. Insert a placeholder `groups` row to mint a UUID.
 *   3. Resolve member wallet addresses from `users` table.
 *   4. Derive a per-group custodial wallet (deterministic from groupId).
 *   5. Update the row with the derived wallet address.
 *   6. Insert `group_members` rows (creator = owner, others = member).
 *
 * Notes:
 *   - Each group gets an isolated custodial wallet derived from the
 *     resolver key + groupId. The app signs all on-chain txs.
 *   - vault_address comes from env (Morpho USDC on Base for v1).
 */

const Body = z.object({
  name: z.string().trim().min(1).max(80),
  // BetPal users.id values for the OTHER members (creator excluded — implicit).
  memberIds: z.array(z.string().uuid()).max(20).default([]),
  // Vault selected from LI.FI Earn API. Falls back to env default if omitted.
  vaultAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  vaultChainId: z.number().int().positive().optional(),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const me = await requireUser(request);
    const json = await request.json().catch(() => {
      throw new HttpError(400, "invalid json body");
    });
    const body = Body.parse(json);

    const sb = supabaseService();

    // Resolve other-member wallet addresses up front so we can fail fast if any
    // user id is bogus. Creator's wallet comes from `me`.
    const otherIds = body.memberIds.filter((id) => id !== me.id);
    let otherMembers: { id: string; wallet_address: string }[] = [];
    if (otherIds.length > 0) {
      const { data, error } = await sb
        .from("users")
        .select("id, wallet_address")
        .in("id", otherIds);
      if (error) throw new HttpError(500, `member lookup failed: ${error.message}`);
      if (!data || data.length !== otherIds.length) {
        throw new HttpError(400, "one or more memberIds are unknown");
      }
      otherMembers = data as { id: string; wallet_address: string }[];
    }

    // Step 2: insert placeholder group row to mint an id. We must satisfy the
    // `threshold >= 2` check, so seed with 2; we'll overwrite with the real
    // value in the update below.
    // Auto-select highest APY USDC vault on Base via LI.FI Earn.
    // Can be overridden per group at creation or switched later via 4-eye vault-switch.
    let vaultAddress = body.vaultAddress;
    if (!vaultAddress) {
      const best = await bestUsdcVaultOnBase();
      vaultAddress = best.address;
    }
    const vaultChainId = body.vaultChainId ?? BASE_CHAIN_ID;

    const { data: groupRow, error: insertErr } = await sb
      .from("groups")
      .insert({
        name: body.name,
        vault_address: vaultAddress,
        vault_chain_id: vaultChainId,
        threshold: 2,
        status: "pending",
        created_by: me.id,
      })
      .select("id")
      .single();
    if (insertErr || !groupRow) {
      throw new HttpError(500, `group insert failed: ${insertErr?.message}`);
    }
    const groupId = groupRow.id as string;

    // Step 4: create a Privy server wallet for this group.
    const { walletId, address: walletAddress } = await createGroupWallet();

    // Step 5: write the wallet address and Privy wallet ID.
    const { error: updateErr } = await sb
      .from("groups")
      .update({ wallet_address: walletAddress, privy_wallet_id: walletId, threshold: 2 })
      .eq("id", groupId);
    if (updateErr) {
      await sb.from("groups").delete().eq("id", groupId);
      throw new HttpError(500, `group update failed: ${updateErr.message}`);
    }

    // Step 6: membership rows. Creator is owner; the rest are members.
    const membershipRows = [
      { group_id: groupId, user_id: me.id, role: "owner" as const },
      ...otherMembers.map((m) => ({
        group_id: groupId,
        user_id: m.id,
        role: "member" as const,
      })),
    ];
    const { error: memberErr } = await sb.from("group_members").insert(membershipRows);
    if (memberErr) {
      await sb.from("groups").delete().eq("id", groupId);
      throw new HttpError(500, `member insert failed: ${memberErr.message}`);
    }

    return Response.json(
      {
        id: groupId,
        name: body.name,
        wallet_address: walletAddress,
        vault_address: vaultAddress,
        vault_chain_id: vaultChainId,
        status: "pending",
        member_count: membershipRows.length,
      },
      { status: 201 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * GET /api/groups
 *
 * List groups the caller is a member of.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const me = await requireUser(request);
    const sb = supabaseService();
    const { data, error } = await sb
      .from("group_members")
      .select(
        "role, group:groups(id, name, wallet_address, vault_address, status, created_at)",
      )
      .eq("user_id", me.id);
    if (error) throw new HttpError(500, `group list failed: ${error.message}`);
    return Response.json({ groups: data ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
}
