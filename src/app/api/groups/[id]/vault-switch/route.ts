import "server-only";
import { z } from "zod";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/supabase";
import { findVaultByAddress, vaultApy, isFullyTransactable } from "@/lib/earn";
import { USDC_BASE } from "@/lib/constants";

/**
 * Vault switch — 4-eye principle.
 *
 *   POST  /api/groups/:id/vault-switch          — propose a switch
 *   GET   /api/groups/:id/vault-switch          — get current proposal (if any)
 *   DELETE /api/groups/:id/vault-switch         — reject / cancel proposal
 *
 * Accept is handled via /api/groups/:id/vault-switch/accept (separate route).
 *
 * Any group member can propose. A DIFFERENT member must accept.
 * Proposer can cancel their own proposal. Any member can reject.
 */

const ProposeBody = z.object({
  newVaultAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});

async function requireMembership(sb: ReturnType<typeof supabaseService>, groupId: string, userId: string) {
  const { data } = await sb
    .from("group_members")
    .select("user_id")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new HttpError(403, "not a member of this group");
}

/**
 * POST — propose a vault switch. Validates the new vault via LI.FI Earn.
 */
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
    const body = ProposeBody.parse(json);
    const newVault = body.newVaultAddress.toLowerCase();

    const sb = supabaseService();
    await requireMembership(sb, groupId, me.id);

    // Load group
    const { data: group } = await sb
      .from("groups")
      .select("id, vault_address, vault_chain_id, pending_vault_address")
      .eq("id", groupId)
      .single();
    if (!group) throw new HttpError(404, "group not found");

    if (group.pending_vault_address) {
      throw new HttpError(409, "a vault switch is already pending — accept, reject, or cancel it first");
    }

    const oldVault = (group.vault_address as string).toLowerCase();
    if (oldVault === newVault) {
      throw new HttpError(400, "new vault is the same as the current vault");
    }

    // Validate new vault on LI.FI Earn (use list endpoint — detail 404s for many vaults)
    const detail = await findVaultByAddress({
      chainId: Number(group.vault_chain_id),
      address: newVault,
    });
    if (!detail) {
      throw new HttpError(400, "vault not found on LI.FI Earn for this chain");
    }
    const underlying = detail.underlyingTokens?.[0]?.address?.toLowerCase();
    if (underlying !== USDC_BASE.toLowerCase()) {
      throw new HttpError(400, "new vault must use USDC as underlying asset");
    }
    if (!isFullyTransactable(detail)) {
      throw new HttpError(
        400,
        "vault is not fully transactable on LI.FI (missing deposit or redeem route)",
      );
    }

    // Store proposal
    const { error: updateErr } = await sb
      .from("groups")
      .update({
        pending_vault_address: newVault,
        pending_vault_proposed_by: me.id,
        pending_vault_proposed_at: new Date().toISOString(),
      })
      .eq("id", groupId);
    if (updateErr) throw new HttpError(500, `proposal failed: ${updateErr.message}`);

    return Response.json({
      status: "proposed",
      new_vault: newVault,
      new_vault_name: detail.name,
      new_vault_apy: vaultApy(detail),
      proposed_by: me.id,
      message: "Waiting for another member to accept.",
    }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * GET — check if there's a pending vault switch proposal.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId } = await params;

    const sb = supabaseService();
    await requireMembership(sb, groupId, me.id);

    const { data: group } = await sb
      .from("groups")
      .select("pending_vault_address, pending_vault_proposed_by, pending_vault_proposed_at, vault_address, vault_chain_id")
      .eq("id", groupId)
      .single();
    if (!group) throw new HttpError(404, "group not found");

    if (!group.pending_vault_address) {
      return Response.json({ pending: false });
    }

    // Enrich with vault details (use list endpoint — detail 404s for many vaults)
    let newVaultName: string | null = null;
    let newVaultApy: number | undefined;
    try {
      const found = await findVaultByAddress({
        chainId: Number(group.vault_chain_id),
        address: group.pending_vault_address as string,
      });
      if (found) {
        newVaultName = found.name ?? null;
        newVaultApy = vaultApy(found);
      }
    } catch { /* silent — vault info is optional */ }

    // Get proposer display name
    let proposerName: string | null = null;
    if (group.pending_vault_proposed_by) {
      const { data: user } = await sb
        .from("users")
        .select("display_name, wallet_address")
        .eq("id", group.pending_vault_proposed_by)
        .single();
      proposerName = (user?.display_name as string) ?? (user?.wallet_address as string) ?? null;
    }

    return Response.json({
      pending: true,
      new_vault: group.pending_vault_address,
      new_vault_name: newVaultName,
      new_vault_apy: newVaultApy,
      proposed_by: group.pending_vault_proposed_by,
      proposed_by_name: proposerName,
      proposed_at: group.pending_vault_proposed_at,
      can_accept: group.pending_vault_proposed_by !== me.id,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * DELETE — reject or cancel a pending vault switch.
 * Any member can reject. Proposer can cancel.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const me = await requireUser(request);
    const { id: groupId } = await params;

    const sb = supabaseService();
    await requireMembership(sb, groupId, me.id);

    const { error: updateErr } = await sb
      .from("groups")
      .update({
        pending_vault_address: null,
        pending_vault_proposed_by: null,
        pending_vault_proposed_at: null,
      })
      .eq("id", groupId);
    if (updateErr) throw new HttpError(500, `rejection failed: ${updateErr.message}`);

    return Response.json({ status: "rejected" });
  } catch (e) {
    return errorResponse(e);
  }
}
