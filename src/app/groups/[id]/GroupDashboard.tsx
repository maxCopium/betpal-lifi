"use client";

/**
 * GroupDashboard — multi-window Win98 desktop for a group.
 *
 * Each section (group info, deposit, withdraw, bets) is its own
 * DraggableWindow that can be moved, minimized, and restored from
 * the taskbar. WalletWindow is a separate persistent window.
 */
import { useCallback, useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { authedFetch } from "@/lib/clientFetch";
import { DraggableWindow } from "@/components/win98/DraggableWindow";
import { WalletWindow } from "@/components/win98/WalletWindow";
import { DepositForm } from "./DepositForm";
import { WithdrawForm } from "./WithdrawForm";
import { NewBetDialog } from "./NewBetDialog";
import { BetList } from "./BetList";
import { useVaultInfo } from "@/hooks/useVaultInfo";

type GroupRow = {
  id: string;
  name: string;
  safe_address: string | null;
  vault_address: string;
  threshold: number;
  status: string;
  created_at: string;
};

type ListResponse = {
  groups: { role: string; group: GroupRow | null }[];
};

type InviteResponse = { token: string; expires_at: string };

type BalanceResponse = {
  user_balance_cents: number;
  user_free_cents: number;
  group_total_cents: number;
};

type ReconcileResponse = {
  ledger_cents: number;
  onchain_cents: number | null;
  drift_cents: number | null;
  onchain_available: boolean;
};

function fmtCents(c: number): string {
  const dollars = c / 100;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

export function GroupDashboard({ groupId }: { groupId: string }) {
  const { ready, authenticated, login } = usePrivy();
  const [group, setGroup] = useState<GroupRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [balance, setBalance] = useState<BalanceResponse | null>(null);
  const [reconcile, setReconcile] = useState<ReconcileResponse | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [newBetOpen, setNewBetOpen] = useState(false);
  const [betsRefreshKey, setBetsRefreshKey] = useState(0);
  const { info: vaultInfo } = useVaultInfo(8453, group?.vault_address ?? "");

  async function runReconcile() {
    setReconciling(true);
    try {
      const r = await authedFetch<ReconcileResponse>(
        `/api/groups/${groupId}/reconcile`,
      );
      setReconcile(r);
    } catch (e) {
      console.warn("reconcile failed:", e);
    } finally {
      setReconciling(false);
    }
  }

  const loadBalance = useCallback(async () => {
    try {
      const b = await authedFetch<BalanceResponse>(`/api/groups/${groupId}/balance`);
      setBalance(b);
    } catch (e) {
      console.warn("balance fetch failed:", e);
    }
  }, [groupId]);

  async function createInvite() {
    setInviteError(null);
    setInviting(true);
    try {
      const res = await authedFetch<InviteResponse>(
        `/api/groups/${groupId}/invites`,
        { method: "POST" },
      );
      const url = `${window.location.origin}/invite/${res.token}`;
      setInviteLink(url);
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        /* clipboard may be blocked */
      }
    } catch (e) {
      setInviteError((e as Error).message);
    } finally {
      setInviting(false);
    }
  }

  useEffect(() => {
    if (!ready || !authenticated) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await authedFetch<ListResponse>("/api/groups");
        if (cancelled) return;
        const match = data.groups.find((g) => g.group?.id === groupId);
        if (!match?.group) {
          setError("Group not found or you are not a member.");
        } else {
          setGroup(match.group);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    void loadBalance();
    return () => { cancelled = true; };
  }, [ready, authenticated, groupId, loadBalance]);

  if (!ready) return <p>Loading…</p>;
  if (!authenticated) {
    return (
      <div className="flex flex-col gap-3">
        <p>Sign in to view this group.</p>
        <div><button onClick={() => login()}>Sign in</button></div>
      </div>
    );
  }
  if (loading) return <p>Loading group…</p>;
  if (error) return <p style={{ color: "#a00" }}>{error}</p>;
  if (!group) return <p>Not found.</p>;

  return (
    <>
      {/* ── Wallet Window ── */}
      <WalletWindow />

      {/* ── Group Info Window ── */}
      <DraggableWindow id="group-info" title={group.name}>
        <div className="flex flex-col gap-2 text-sm" style={{ padding: 4 }}>
          <div><strong>Status:</strong> {group.status}</div>
          <div><strong>Threshold:</strong> {group.threshold} signers</div>

          {/* Vault yield info */}
          {vaultInfo && vaultInfo.apy && (
            <div style={{
              background: "#ffffcc",
              border: "1px solid #e0e000",
              padding: "4px 6px",
              fontSize: 11,
            }}>
              Your money earns{" "}
              <strong style={{ color: "#080" }}>
                {(vaultInfo.apy.total * 100).toFixed(2)}% APY
              </strong>
              {" "}via {vaultInfo.protocol ?? "Morpho"}
              {vaultInfo.tvl && (
                <span style={{ color: "#666" }}>
                  {" "}· TVL ${vaultInfo.tvl.usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </span>
              )}
            </div>
          )}

          {/* Balance */}
          <div className="flex items-center justify-between" style={{ marginTop: 4 }}>
            <strong>Balance</strong>
            <button onClick={runReconcile} disabled={reconciling} style={{ fontSize: 10 }}>
              {reconciling ? "Checking…" : "Reconcile"}
            </button>
          </div>
          {balance ? (
            <ul className="text-xs" style={{ margin: 0, paddingLeft: 16 }}>
              <li>Your share: {fmtCents(balance.user_balance_cents)}</li>
              <li>Free (not in bets): {fmtCents(balance.user_free_cents)}</li>
              <li>Group total: {fmtCents(balance.group_total_cents)}</li>
            </ul>
          ) : (
            <span className="text-xs">Loading…</span>
          )}
          {reconcile && (
            <div className="text-xs" style={{ marginTop: 2 }}>
              On-chain:{" "}
              {reconcile.onchain_available && reconcile.onchain_cents !== null
                ? fmtCents(reconcile.onchain_cents)
                : "(Safe not deployed)"}
              {reconcile.drift_cents !== null && (
                <>
                  {" · drift "}
                  <span style={{ color: Math.abs(reconcile.drift_cents) > 100 ? "#a00" : "inherit" }}>
                    {fmtCents(reconcile.drift_cents)}
                  </span>
                </>
              )}
            </div>
          )}

          {/* Invite */}
          <div style={{ marginTop: 4 }}>
            <button onClick={createInvite} disabled={inviting || group.status !== "pending"}>
              {inviting ? "Generating…" : "Invite a friend"}
            </button>
          </div>
          {inviteError && (
            <p className="text-xs" role="alert" style={{ color: "#a00" }}>{inviteError}</p>
          )}
          {inviteLink && (
            <div className="text-xs flex flex-col gap-1">
              <span>Invite link (copied):</span>
              <code className="break-all">{inviteLink}</code>
            </div>
          )}
        </div>
      </DraggableWindow>

      {/* ── Deposit Window ── */}
      <DraggableWindow id="deposit" title="Deposit">
        <div style={{ padding: 4 }}>
          <DepositForm groupId={groupId} />
        </div>
      </DraggableWindow>

      {/* ── Withdraw Window ── */}
      <DraggableWindow id="withdraw" title="Withdraw">
        <div style={{ padding: 4 }}>
          <WithdrawForm
            groupId={groupId}
            safeAddress={group.safe_address}
            onWithdrawn={loadBalance}
          />
        </div>
      </DraggableWindow>

      {/* ── Bets Window ── */}
      <DraggableWindow id="bets" title="Bets">
        <div className="flex flex-col gap-1" style={{ padding: 4 }}>
          <div className="flex items-center justify-between">
            <strong>Active Bets</strong>
            <button
              onClick={() => setNewBetOpen(true)}
              disabled={group.status === "closed"}
            >
              New bet
            </button>
          </div>
          <BetList groupId={groupId} refreshKey={betsRefreshKey} />
        </div>
      </DraggableWindow>

      <NewBetDialog
        open={newBetOpen}
        groupId={groupId}
        onClose={() => setNewBetOpen(false)}
        onCreated={() => setBetsRefreshKey((k) => k + 1)}
      />
    </>
  );
}
