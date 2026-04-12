"use client";

/**
 * GroupDashboard — multi-window Win98 desktop for a group.
 *
 * Each section (group info, deposit, withdraw, bets) is its own
 * DraggableWindow that can be moved, minimized, and restored from
 * the taskbar. Wallet is shown in the sidebar (SidebarWallet).
 */
import { useCallback, useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { authedFetch } from "@/lib/clientFetch";
import { DraggableWindow } from "@/components/win98/DraggableWindow";
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

type MemberRow = {
  user_id: string;
  role: string;
  display_name: string | null;
  wallet_address: string | null;
};

type MembersResponse = { members: MemberRow[] };

type GasResponse = {
  wallet_address: string;
  balance_eth: number;
  txs_affordable: number;
  needs_funding: boolean;
};

type VaultOption = {
  address: string;
  name: string | null;
  apy: number | null;
  tvl_usd: number | null;
  protocol: string;
};

type VaultProposal = {
  pending: boolean;
  new_vault?: string;
  new_vault_name?: string;
  new_vault_apy?: number;
  proposed_by_name?: string;
  proposed_by?: string;
  proposed_at?: string;
  can_accept?: boolean;
};

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

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
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [myRole, setMyRole] = useState<string | null>(null);
  const [gas, setGas] = useState<GasResponse | null>(null);
  const [betterVaults, setBetterVaults] = useState<VaultOption[]>([]);
  const [proposal, setProposal] = useState<VaultProposal | null>(null);
  const [vaultActionPending, setVaultActionPending] = useState(false);
  const [vaultMessage, setVaultMessage] = useState<string | null>(null);
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
          setMyRole(match.role);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    void loadBalance();
    void authedFetch<MembersResponse>(`/api/groups/${groupId}/members`)
      .then((r) => {
        if (cancelled) return;
        setMembers(r.members);
      })
      .catch(() => {});
    void authedFetch<GasResponse>(`/api/groups/${groupId}/gas`)
      .then((r) => { if (!cancelled) setGas(r); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ready, authenticated, groupId, loadBalance]);

  // Fetch pending proposal + better vaults
  const loadProposal = useCallback(async () => {
    try {
      const p = await authedFetch<VaultProposal>(`/api/groups/${groupId}/vault-switch`);
      setProposal(p);
    } catch { /* silent */ }
  }, [groupId]);

  useEffect(() => {
    if (!ready || !authenticated) return;
    void loadProposal();
  }, [ready, authenticated, loadProposal]);

  useEffect(() => {
    if (!vaultInfo?.apy || !group?.vault_address) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await authedFetch<{ vaults: VaultOption[] }>(
          `/api/earn/vaults?chainId=8453&asset=USDC&limit=5`,
        );
        const currentAddr = group.vault_address.toLowerCase();
        const better = (data.vaults ?? []).filter(
          (v: VaultOption) =>
            v.address.toLowerCase() !== currentAddr &&
            v.apy !== null &&
            v.apy > (vaultInfo.apy?.total ?? 0),
        );
        if (!cancelled) setBetterVaults(better);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [vaultInfo, group?.vault_address]);

  async function proposeSwitch(newAddr: string) {
    setVaultActionPending(true);
    setVaultMessage(null);
    try {
      const res = await authedFetch<{ new_vault_name: string; new_vault_apy: number }>(
        `/api/groups/${groupId}/vault-switch`,
        { method: "POST", body: JSON.stringify({ newVaultAddress: newAddr }) },
      );
      setVaultMessage(`Proposed switch to ${res.new_vault_name} (${res.new_vault_apy?.toFixed(2)}% APY). Waiting for another member to accept.`);
      void loadProposal();
    } catch (e) {
      setVaultMessage(`Proposal failed: ${(e as Error).message}`);
    } finally {
      setVaultActionPending(false);
    }
  }

  async function acceptSwitch() {
    setVaultActionPending(true);
    setVaultMessage(null);
    try {
      const res = await authedFetch<{ new_vault_name: string; new_vault_apy: number; usdc_migrated_cents: number }>(
        `/api/groups/${groupId}/vault-switch/accept`,
        { method: "POST" },
      );
      setVaultMessage(`Switched to ${res.new_vault_name} (${res.new_vault_apy?.toFixed(2)}% APY). Migrated ${fmtCents(res.usdc_migrated_cents)}.`);
      window.location.reload();
    } catch (e) {
      setVaultMessage(`Accept failed: ${(e as Error).message}`);
    } finally {
      setVaultActionPending(false);
    }
  }

  async function rejectSwitch() {
    setVaultActionPending(true);
    setVaultMessage(null);
    try {
      await authedFetch(`/api/groups/${groupId}/vault-switch`, { method: "DELETE" });
      setVaultMessage("Vault switch rejected.");
      setProposal(null);
    } catch (e) {
      setVaultMessage(`Rejection failed: ${(e as Error).message}`);
    } finally {
      setVaultActionPending(false);
    }
  }

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
      {/* ── Group Info Window ── */}
      <DraggableWindow id="group-info" title={group.name}>
        <div className="flex flex-col gap-3">
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <div><strong>Status:</strong> {group.status}</div>
            <div><strong>Members:</strong> {members.length || group.threshold}</div>
          </div>

          {/* Member list */}
          {members.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {members.map((m) => (
                <span
                  key={m.user_id}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "2px 8px",
                    background: m.role === "owner" ? "#e6e8ff" : "#f0f0f0",
                    border: "1px solid #ccc",
                    fontSize: 12,
                  }}
                >
                  {m.display_name || (m.wallet_address ? shortAddr(m.wallet_address) : "Unknown")}
                  {m.role === "owner" && (
                    <span style={{ fontSize: 10, opacity: 0.6 }}>owner</span>
                  )}
                </span>
              ))}
            </div>
          )}

          {/* Vault yield info */}
          {vaultInfo && vaultInfo.apy && (
            <div className="betpal-alert betpal-alert--success" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>Your money earns</span>
              <strong style={{ fontSize: 15 }}>
                {vaultInfo.apy.total.toFixed(2)}% APY
              </strong>
              <span>via {vaultInfo.protocol ?? "Morpho"}</span>
              {vaultInfo.tvl && (
                <span style={{ opacity: 0.7 }}>
                  · TVL ${vaultInfo.tvl.usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </span>
              )}
            </div>
          )}

          {/* Server wallet + gas */}
          {gas && gas.needs_funding && (
            <div className="betpal-alert betpal-alert--error" style={{ fontSize: 12 }}>
              <strong>Gas needed:</strong> The group wallet has {gas.balance_eth.toFixed(6)} ETH on Base
              ({gas.txs_affordable} txs remaining). Send Base ETH to enable payouts:
              <code className="break-all" style={{ display: "block", marginTop: 4, fontSize: 11 }}>
                {gas.wallet_address}
              </code>
            </div>
          )}
          {gas && !gas.needs_funding && (
            <div style={{ fontSize: 12 }}>
              <span style={{ opacity: 0.6 }}>Gas: {gas.balance_eth.toFixed(6)} ETH (~{gas.txs_affordable} txs)</span>
              {myRole === "owner" && (
                <details style={{ marginTop: 4 }}>
                  <summary style={{ cursor: "pointer", fontSize: 11, opacity: 0.6 }}>Group wallet address</summary>
                  <code className="break-all" style={{ display: "block", marginTop: 2, fontSize: 11 }}>
                    {gas.wallet_address}
                  </code>
                </details>
              )}
            </div>
          )}

          {/* Pending vault switch proposal */}
          {proposal?.pending && (
            <div className="betpal-alert betpal-alert--info" style={{ fontSize: 12 }}>
              <strong>Vault switch proposed</strong> by {proposal.proposed_by_name ?? "a member"}
              <div style={{ marginTop: 4 }}>
                Switch to <strong>{proposal.new_vault_name ?? shortAddr(proposal.new_vault ?? "")}</strong>
                {proposal.new_vault_apy != null && <> ({proposal.new_vault_apy.toFixed(2)}% APY)</>}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                {proposal.can_accept && (
                  <button
                    onClick={acceptSwitch}
                    disabled={vaultActionPending}
                    style={{ fontSize: 11, padding: "2px 8px" }}
                  >
                    {vaultActionPending ? "Migrating…" : "Accept"}
                  </button>
                )}
                {!proposal.can_accept && (
                  <span style={{ opacity: 0.6, fontSize: 11 }}>Waiting for another member…</span>
                )}
                <button
                  onClick={rejectSwitch}
                  disabled={vaultActionPending}
                  style={{ fontSize: 11, padding: "2px 8px" }}
                >
                  Reject
                </button>
              </div>
            </div>
          )}

          {/* Higher APY vaults — only show if no pending proposal */}
          {!proposal?.pending && betterVaults.length > 0 && !vaultActionPending && (
            <div className="betpal-alert betpal-alert--info" style={{ fontSize: 12 }}>
              <strong>Higher APY available:</strong>
              {betterVaults.slice(0, 2).map((v) => (
                <div key={v.address} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                  <span>
                    {v.name ?? "Vault"} ({v.protocol}) — <strong>{v.apy?.toFixed(2)}%</strong> APY
                  </span>
                  <button
                    style={{ fontSize: 11, padding: "2px 8px" }}
                    onClick={() => proposeSwitch(v.address)}
                    disabled={vaultActionPending}
                  >
                    Propose switch
                  </button>
                </div>
              ))}
              <div style={{ marginTop: 4, opacity: 0.6, fontSize: 11 }}>
                A second member must accept the switch before funds migrate.
              </div>
            </div>
          )}
          {vaultActionPending && !proposal?.pending && (
            <div className="betpal-alert betpal-alert--info">Processing…</div>
          )}
          {vaultMessage && (
            <div className={`betpal-alert ${vaultMessage.includes("failed") ? "betpal-alert--error" : "betpal-alert--success"}`}>
              {vaultMessage}
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
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>
                    On-chain:{" "}
                    {reconcile.onchain_available && reconcile.onchain_cents !== null
                      ? fmtCents(reconcile.onchain_cents)
                      : "(vault not initialized)"}
                  </span>
                  {reconcile.drift_cents !== null && reconcile.drift_cents > 0 && (
                    <span style={{ color: "#2e7d32", fontWeight: "bold" }}>
                      +{fmtCents(reconcile.drift_cents)} yield earned
                    </span>
                  )}
                  {reconcile.drift_cents !== null && reconcile.drift_cents < 0 && (
                    <span style={{ color: "var(--betpal-color-error)" }}>
                      {fmtCents(reconcile.drift_cents)} drift
                    </span>
                  )}
                </div>
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
