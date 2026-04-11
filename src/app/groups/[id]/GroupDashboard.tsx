"use client";

/**
 * GroupDashboard — Day 2 stub.
 *
 * Reads the caller's group list (`GET /api/groups`) and finds the matching
 * one. Real per-group endpoints (members, balance, deposits) land later in
 * Day 2 alongside the deposit flow.
 */
import { useCallback, useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { authedFetch } from "@/lib/clientFetch";
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
  const vaultChainId = 8453;
  const { info: vaultInfo } = useVaultInfo(vaultChainId, group?.vault_address ?? "");

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
        // clipboard may be blocked; the link is still visible.
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
    return () => {
      cancelled = true;
    };
  }, [ready, authenticated, groupId, loadBalance]);

  if (!ready) return <p>Loading…</p>;
  if (!authenticated) {
    return (
      <div className="flex flex-col gap-3">
        <p>Sign in to view this group.</p>
        <div>
          <button onClick={() => login()}>Sign in</button>
        </div>
      </div>
    );
  }
  if (loading) return <p>Loading group…</p>;
  if (error) return <p style={{ color: "#a00" }}>{error}</p>;
  if (!group) return <p>Not found.</p>;

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div>
        <strong>Name:</strong> {group.name}
      </div>
      <div>
        <strong>Status:</strong> {group.status}
      </div>
      <div>
        <strong>Threshold:</strong> {group.threshold} signers
      </div>
      <div className="break-all">
        <strong>Safe:</strong> {group.safe_address ?? "(pending)"}
      </div>
      <div className="break-all">
        <strong>Vault:</strong> {group.vault_address}
      </div>
      {vaultInfo && (
        <div className="window" style={{ marginTop: 4 }}>
          <div className="title-bar" style={{ padding: "2px 4px" }}>
            <div className="title-bar-text" style={{ fontSize: 11 }}>
              Yield Info (via LI.FI Earn)
            </div>
          </div>
          <div className="window-body" style={{ padding: 6 }}>
            <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
              <tbody>
                {vaultInfo.protocol && (
                  <tr>
                    <td style={{ padding: "1px 0", color: "#666" }}>Protocol</td>
                    <td style={{ padding: "1px 0", textAlign: "right", fontWeight: 600 }}>{vaultInfo.protocol}</td>
                  </tr>
                )}
                {vaultInfo.apy && (
                  <tr>
                    <td style={{ padding: "1px 0", color: "#666" }}>APY</td>
                    <td style={{ padding: "1px 0", textAlign: "right", fontWeight: 600, color: "#080" }}>
                      {(vaultInfo.apy.total * 100).toFixed(2)}%
                      {vaultInfo.apy.base != null && vaultInfo.apy.reward != null && (
                        <span style={{ fontWeight: 400, color: "#666" }}>
                          {" "}({(vaultInfo.apy.base * 100).toFixed(1)}% base + {(vaultInfo.apy.reward * 100).toFixed(1)}% reward)
                        </span>
                      )}
                    </td>
                  </tr>
                )}
                {vaultInfo.tvl && (
                  <tr>
                    <td style={{ padding: "1px 0", color: "#666" }}>TVL</td>
                    <td style={{ padding: "1px 0", textAlign: "right", fontWeight: 600 }}>
                      ${vaultInfo.tvl.usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                    </td>
                  </tr>
                )}
                {vaultInfo.asset && (
                  <tr>
                    <td style={{ padding: "1px 0", color: "#666" }}>Asset</td>
                    <td style={{ padding: "1px 0", textAlign: "right" }}>{vaultInfo.asset}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1" style={{ marginTop: 8 }}>
        <div>
          <button onClick={createInvite} disabled={inviting || group.status !== "pending"}>
            {inviting ? "Generating…" : "Invite a friend"}
          </button>
        </div>
        {group.status !== "pending" && (
          <p className="text-xs">
            Group is no longer pending — invites are frozen until membership unfreeze
            (post-deploy owner-add not yet wired).
          </p>
        )}
        {inviteError && (
          <p className="text-xs" role="alert" style={{ color: "#a00" }}>
            {inviteError}
          </p>
        )}
        {inviteLink && (
          <div className="text-xs flex flex-col gap-1">
            <span>Invite link (copied to clipboard):</span>
            <code className="break-all">{inviteLink}</code>
          </div>
        )}
      </div>
      <hr style={{ marginTop: 8, marginBottom: 8 }} />
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <strong>Balance</strong>
          <button onClick={runReconcile} disabled={reconciling}>
            {reconciling ? "Checking…" : "Reconcile vs vault"}
          </button>
        </div>
        {balance ? (
          <ul className="text-xs" style={{ margin: 0, paddingLeft: 16 }}>
            <li>Your share: {fmtCents(balance.user_balance_cents)}</li>
            <li>Free (not in open bets): {fmtCents(balance.user_free_cents)}</li>
            <li>Group total (ledger): {fmtCents(balance.group_total_cents)}</li>
          </ul>
        ) : (
          <span className="text-xs">Loading…</span>
        )}
        {reconcile && (
          <div className="text-xs" style={{ marginTop: 4 }}>
            On-chain vault:{" "}
            {reconcile.onchain_available && reconcile.onchain_cents !== null
              ? fmtCents(reconcile.onchain_cents)
              : "(Safe not deployed yet)"}
            {reconcile.drift_cents !== null && (
              <>
                {" · drift "}
                <span
                  style={{
                    color:
                      Math.abs(reconcile.drift_cents) > 100 ? "#a00" : "inherit",
                  }}
                >
                  {fmtCents(reconcile.drift_cents)}
                </span>
              </>
            )}
          </div>
        )}
      </div>
      <hr style={{ marginTop: 8, marginBottom: 8 }} />
      <div className="flex flex-col gap-1">
        <strong>Deposit</strong>
        <DepositForm groupId={groupId} />
      </div>
      <hr style={{ marginTop: 8, marginBottom: 8 }} />
      <div className="flex flex-col gap-1">
        <strong>Withdraw</strong>
        <WithdrawForm
          groupId={groupId}
          safeAddress={group.safe_address}
          onWithdrawn={loadBalance}
        />
      </div>
      <hr style={{ marginTop: 8, marginBottom: 8 }} />
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <strong>Bets</strong>
          <button
            onClick={() => setNewBetOpen(true)}
            disabled={group.status === "closed"}
          >
            New bet
          </button>
        </div>
        <BetList groupId={groupId} refreshKey={betsRefreshKey} />
      </div>
      <NewBetDialog
        open={newBetOpen}
        groupId={groupId}
        onClose={() => setNewBetOpen(false)}
        onCreated={() => setBetsRefreshKey((k) => k + 1)}
      />
    </div>
  );
}
