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
      <div className="flex flex-col gap-4" style={{ padding: 16 }}>
        <p>Sign in to view this group.</p>
        <div><button onClick={() => login()}>Sign in</button></div>
      </div>
    );
  }
  if (loading) return <p>Loading group…</p>;
  if (error) return <div className="betpal-alert betpal-alert--error">{error}</div>;
  if (!group) return <p>Not found.</p>;

  return (
    <>
      {/* ── Wallet Window ── */}
      <WalletWindow />

      {/* ── Group Info Window ── */}
      <DraggableWindow id="group-info" title={group.name}>
        <div className="flex flex-col gap-3">
          <div style={{ display: "flex", gap: 16 }}>
            <div><strong>Status:</strong> {group.status}</div>
            <div><strong>Members:</strong> {group.threshold}</div>
          </div>

          {/* Vault yield info */}
          {vaultInfo && vaultInfo.apy && (
            <div className="betpal-alert betpal-alert--success" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>Your money earns</span>
              <strong style={{ fontSize: 15 }}>
                {(vaultInfo.apy.total * 100).toFixed(2)}% APY
              </strong>
              <span>via {vaultInfo.protocol ?? "Morpho"}</span>
              {vaultInfo.tvl && (
                <span style={{ opacity: 0.7 }}>
                  · TVL ${vaultInfo.tvl.usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </span>
              )}
            </div>
          )}

          {/* Balance */}
          <div>
            <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
              <strong>Balance</strong>
              <button onClick={runReconcile} disabled={reconciling}>
                {reconciling ? "Checking…" : "Reconcile"}
              </button>
            </div>
            {balance ? (
              <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8 }}>
                <li>Your share: <strong>{fmtCents(balance.user_balance_cents)}</strong></li>
                <li>Free (not in bets): <strong>{fmtCents(balance.user_free_cents)}</strong></li>
                <li>Group total: <strong>{fmtCents(balance.group_total_cents)}</strong></li>
              </ul>
            ) : (
              <span style={{ opacity: 0.6 }}>Loading…</span>
            )}
            {reconcile && (
              <div style={{ marginTop: 8, padding: "6px 10px", background: "#f0f0f0", border: "1px solid #ccc" }}>
                On-chain:{" "}
                {reconcile.onchain_available && reconcile.onchain_cents !== null
                  ? fmtCents(reconcile.onchain_cents)
                  : "(vault not initialized)"}
                {reconcile.drift_cents !== null && (
                  <>
                    {" · drift "}
                    <strong style={{ color: Math.abs(reconcile.drift_cents) > 100 ? "var(--betpal-color-error)" : "inherit" }}>
                      {fmtCents(reconcile.drift_cents)}
                    </strong>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Invite */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={createInvite} disabled={inviting || group.status !== "pending"}>
              {inviting ? "Generating…" : "Invite a friend"}
            </button>
          </div>
          {inviteError && (
            <div className="betpal-alert betpal-alert--error" role="alert">{inviteError}</div>
          )}
          {inviteLink && (
            <div className="betpal-alert betpal-alert--info">
              <div style={{ marginBottom: 4 }}>Invite link (copied to clipboard):</div>
              <code className="break-all" style={{ fontSize: 12 }}>{inviteLink}</code>
            </div>
          )}
        </div>
      </DraggableWindow>

      {/* ── Deposit Window ── */}
      <DraggableWindow id="deposit" title="Deposit">
        <DepositForm groupId={groupId} />
      </DraggableWindow>

      {/* ── Withdraw Window ── */}
      <DraggableWindow id="withdraw" title="Withdraw">
        <WithdrawForm
          groupId={groupId}
          onWithdrawn={loadBalance}
        />
      </DraggableWindow>

      {/* ── Bets Window ── */}
      <DraggableWindow id="bets" title="Bets">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <strong style={{ fontSize: 14 }}>Active Bets</strong>
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
