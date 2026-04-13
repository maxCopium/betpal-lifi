"use client";

/**
 * GroupDashboard — multi-window Win98 desktop for a group.
 *
 * Each section (group info, deposit, withdraw, bets) is its own
 * DraggableWindow that can be moved, minimized, and restored from
 * the taskbar. Wallet is shown in the sidebar (SidebarWallet).
 */
import { useCallback, useEffect, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { authedFetch } from "@/lib/clientFetch";
import { DraggableWindow } from "@/components/win98/DraggableWindow";
import { WithdrawForm } from "./WithdrawForm";
import { NewBetDialog } from "./NewBetDialog";
import { BetList } from "./BetList";
import { useVaultInfo } from "@/hooks/useVaultInfo";
import { BASE_CHAIN_ID } from "@/lib/constants";
import { fmtCents, fmtApy, shortAddr } from "@/lib/format";

type GroupRow = {
  id: string;
  name: string;
  wallet_address: string | null;
  vault_address: string;
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
  risk?: "low" | "medium" | "high";
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
  const [sendingGas, setSendingGas] = useState(false);
  const [gasMsg, setGasMsg] = useState<string | null>(null);
  const [gasEthInput, setGasEthInput] = useState("0.00005");
  const { wallets } = useWallets();
  const [betterVaults, setBetterVaults] = useState<VaultOption[]>([]);
  const [proposal, setProposal] = useState<VaultProposal | null>(null);
  const [vaultActionPending, setVaultActionPending] = useState(false);
  const [vaultMessage, setVaultMessage] = useState<string | null>(null);
  const { info: vaultInfo } = useVaultInfo(BASE_CHAIN_ID, group?.vault_address ?? "");

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

  // Fire-and-forget: warm the Polymarket search index on page load so
  // searches are instant when the user opens the New Bet dialog.
  useEffect(() => { authedFetch("/api/polymarket/warmup").catch(() => {}); }, []);

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
    if (!group?.vault_address) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await authedFetch<{ vaults: VaultOption[] }>(
          `/api/earn/vaults?chainId=${BASE_CHAIN_ID}&asset=USDC&limit=10`,
        );
        const currentAddr = group.vault_address.toLowerCase();
        const currentApy = vaultInfo?.apy?.total ?? 0;
        const others = (data.vaults ?? []).filter(
          (v: VaultOption) => v.address.toLowerCase() !== currentAddr,
        );
        // Show vaults with higher APY first, then the rest
        const sorted = others.sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0));
        if (!cancelled) setBetterVaults(sorted);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [group?.vault_address, vaultInfo]);

  async function proposeSwitch(newAddr: string) {
    setVaultActionPending(true);
    setVaultMessage(null);
    try {
      const res = await authedFetch<{ new_vault_name: string; new_vault_apy: number }>(
        `/api/groups/${groupId}/vault-switch`,
        { method: "POST", body: JSON.stringify({ newVaultAddress: newAddr }) },
      );
      setVaultMessage(`Proposed switch to ${res.new_vault_name} (${fmtApy(res.new_vault_apy ?? null)} APY). Waiting for another member to accept.`);
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
      setVaultMessage(`Switched to ${res.new_vault_name} (${fmtApy(res.new_vault_apy ?? null)} APY). Migrated ${fmtCents(res.usdc_migrated_cents)}.`);
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

  // Send user-specified ETH from user's wallet to group wallet for gas.
  async function sendGas() {
    if (!gas?.wallet_address) return;
    const ethAmount = parseFloat(gasEthInput);
    if (!Number.isFinite(ethAmount) || ethAmount <= 0) {
      setGasMsg("Enter a valid ETH amount");
      return;
    }
    setSendingGas(true);
    setGasMsg(null);
    try {
      const w = wallets.find((wl) => wl.walletClientType === "privy") ?? wallets[0];
      if (!w) throw new Error("No wallet found — sign in first");
      try { await w.switchChain(BASE_CHAIN_ID); } catch { /* continue */ }
      const provider = await w.getEthereumProvider();
      // Convert ETH to wei
      const wei = BigInt(Math.round(ethAmount * 1e18));
      const value = "0x" + wei.toString(16);
      const txHash = await provider.request({
        method: "eth_sendTransaction",
        params: [{ from: w.address, to: gas.wallet_address, value }],
      });
      setGasMsg(`Sent ${ethAmount} ETH! Tx: ${String(txHash).slice(0, 14)}…`);
      // Refresh gas balance after a few seconds
      setTimeout(async () => {
        try {
          const g = await authedFetch<GasResponse>(`/api/groups/${groupId}/gas`);
          setGas(g);
        } catch { /* ignore */ }
      }, 5000);
    } catch (e) {
      setGasMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setSendingGas(false);
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
            <div><strong>Members:</strong> {members.length}</div>
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

          {/* Vault yield info — always show section, even if vault info hasn't loaded */}
          {group?.vault_address ? (
            vaultInfo && vaultInfo.apy ? (
              <div className="betpal-alert betpal-alert--success" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span>Yield strategy:</span>
                <strong style={{ fontSize: 15 }}>
                  {fmtApy(vaultInfo.apy.total)} APY
                </strong>
                <span>via {vaultInfo.protocol ?? "Morpho"}</span>
                {vaultInfo.tvl && (
                  <span style={{ opacity: 0.7 }}>
                    · TVL ${vaultInfo.tvl.usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                  </span>
                )}
              </div>
            ) : (
              <div style={{ opacity: 0.6, fontSize: 12 }}>Loading vault info...</div>
            )
          ) : (
            <div style={{ opacity: 0.6, fontSize: 12 }}>No vault configured yet.</div>
          )}

          {/* Server wallet + gas */}
          {gas && gas.needs_funding && (
            <div className="betpal-alert betpal-alert--error" style={{ fontSize: 12 }}>
              <strong>Gas needed for payouts!</strong> The group wallet has {gas.balance_eth.toFixed(6)} ETH
              ({gas.txs_affordable} txs remaining). Send ~$0.50 of Base ETH to cover ~100 txs:
              <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4 }}>
                <code className="break-all" style={{ fontSize: 11, flex: 1 }}>
                  {gas.wallet_address}
                </code>
                <button
                  type="button"
                  style={{ fontSize: 10, padding: "1px 6px", whiteSpace: "nowrap" }}
                  onClick={() => navigator.clipboard.writeText(gas.wallet_address)}
                >
                  Copy
                </button>
                <input
                  type="number"
                  step="0.00001"
                  min="0.00001"
                  value={gasEthInput}
                  onChange={(e) => setGasEthInput(e.target.value)}
                  style={{ width: 80, fontSize: 10, padding: "1px 4px" }}
                  placeholder="ETH"
                />
                <button
                  type="button"
                  style={{ fontSize: 10, padding: "1px 6px", whiteSpace: "nowrap", background: "#000080", color: "#fff" }}
                  disabled={sendingGas}
                  onClick={sendGas}
                >
                  {sendingGas ? "Sending…" : "Send"}
                </button>
              </div>
              {gasMsg && <div style={{ marginTop: 4, fontSize: 11 }}>{gasMsg}</div>}
            </div>
          )}
          {gas && !gas.needs_funding && (
            <div style={{ fontSize: 12 }}>
              <span style={{ opacity: 0.6 }}>Gas: {gas.balance_eth.toFixed(6)} ETH (~{gas.txs_affordable} txs)</span>
              <details style={{ marginTop: 4 }}>
                <summary style={{ cursor: "pointer", fontSize: 11, opacity: 0.6 }}>Fund gas / wallet address</summary>
                <div style={{ marginTop: 4, fontSize: 11 }}>
                  <div style={{ opacity: 0.7, marginBottom: 4 }}>
                    Send Base ETH to this address to fund payouts:
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <code className="break-all" style={{ fontSize: 11, flex: 1 }}>
                      {gas.wallet_address}
                    </code>
                    <button
                      type="button"
                      style={{ fontSize: 10, padding: "1px 6px", whiteSpace: "nowrap" }}
                      onClick={() => navigator.clipboard.writeText(gas.wallet_address)}
                    >
                      Copy
                    </button>
                    <input
                      type="number"
                      step="0.00001"
                      min="0.00001"
                      value={gasEthInput}
                      onChange={(e) => setGasEthInput(e.target.value)}
                      style={{ width: 80, fontSize: 10, padding: "1px 4px" }}
                      placeholder="ETH"
                    />
                    <button
                      type="button"
                      style={{ fontSize: 10, padding: "1px 6px", whiteSpace: "nowrap", background: "#000080", color: "#fff" }}
                      disabled={sendingGas}
                      onClick={sendGas}
                    >
                      {sendingGas ? "Sending…" : "Send"}
                    </button>
                  </div>
                  {gasMsg && <div style={{ marginTop: 4, fontSize: 11 }}>{gasMsg}</div>}
                </div>
              </details>
            </div>
          )}

          {/* Pending vault switch proposal */}
          {proposal?.pending && (
            <div className="betpal-alert betpal-alert--info" style={{ fontSize: 12 }}>
              <strong>Vault switch proposed</strong> by {proposal.proposed_by_name ?? "a member"}
              <div style={{ marginTop: 4 }}>
                Switch to <strong>{proposal.new_vault_name ?? shortAddr(proposal.new_vault ?? "")}</strong>
                {proposal.new_vault_apy != null && <> ({fmtApy(proposal.new_vault_apy)} APY)</>}
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

          {/* Switch vault — always show available vaults */}
          {!proposal?.pending && betterVaults.length > 0 && !vaultActionPending && (
            <details style={{ fontSize: 12 }}>
              <summary style={{ cursor: "pointer", fontWeight: 700 }}>Switch vault ({betterVaults.length} available)</summary>
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                {betterVaults.slice(0, 5).map((v) => {
                  const currentApy = vaultInfo?.apy?.total ?? 0;
                  const isHigher = v.apy != null && v.apy > currentApy;
                  return (
                    <div key={v.address} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 8px", background: "#f5f5f5", border: "1px solid #ddd" }}>
                      <span>
                        {v.name ?? "Vault"} ({v.protocol}) — <strong>{fmtApy(v.apy ?? null)}</strong> APY
                        {v.tvl_usd != null && <span style={{ opacity: 0.6 }}> · TVL ${v.tvl_usd >= 1_000_000 ? `${(v.tvl_usd / 1_000_000).toFixed(1)}M` : `${(v.tvl_usd / 1_000).toFixed(0)}K`}</span>}
                        {v.risk && <span style={{ marginLeft: 4, fontSize: 10, fontWeight: 600, color: v.risk === "low" ? "#080" : v.risk === "medium" ? "#b80" : "#c00" }}>{v.risk}</span>}
                        {isHigher && <span style={{ marginLeft: 4, fontSize: 10, color: "#080", fontWeight: 600 }}>higher APY</span>}
                      </span>
                      <button
                        style={{ fontSize: 11, padding: "2px 8px" }}
                        onClick={() => proposeSwitch(v.address)}
                        disabled={vaultActionPending}
                      >
                        Propose
                      </button>
                    </div>
                  );
                })}
                <div style={{ opacity: 0.6, fontSize: 11 }}>
                  A second member must accept the switch before funds migrate.
                </div>
              </div>
            </details>
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

      {/* ── Withdraw Window ── */}
      <DraggableWindow id="withdraw" title="Withdraw">
        <WithdrawForm
          groupId={groupId}
          freeBalanceCents={balance?.user_free_cents ?? 0}
          onWithdrawn={loadBalance}
        />
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
