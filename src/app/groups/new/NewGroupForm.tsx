"use client";

/**
 * NewGroupForm — Win98-styled form for creating a betting group.
 *
 * Includes:
 *   - Group name
 *   - Yield strategy picker (powered by LI.FI Earn API)
 *   - Friend search for adding members
 */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { authedFetch } from "@/lib/clientFetch";

type CreatedGroup = {
  id: string;
  name: string;
  safe_address: `0x${string}`;
  threshold: number;
  status: string;
};

type FriendResult = {
  id: string;
  display_name: string | null;
  ens_name: string | null;
  basename: string | null;
  wallet_address: string;
};

type VaultOption = {
  address: string;
  chainId: number;
  name: string | null;
  protocol: string;
  asset: string;
  apy: number | null;
  tvl_usd: number | null;
};

function friendLabel(f: FriendResult): string {
  return (
    f.display_name ||
    f.ens_name ||
    f.basename ||
    `${f.wallet_address.slice(0, 6)}...${f.wallet_address.slice(-4)}`
  );
}

function fmtApy(apy: number | null): string {
  if (apy === null) return "-- %";
  return `${(apy * 100).toFixed(2)}%`;
}

function fmtTvl(tvl: number | null): string {
  if (tvl === null) return "";
  if (tvl >= 1_000_000) return `$${(tvl / 1_000_000).toFixed(1)}M`;
  if (tvl >= 1_000) return `$${(tvl / 1_000).toFixed(0)}K`;
  return `$${tvl.toFixed(0)}`;
}

export function NewGroupForm() {
  const router = useRouter();
  const { ready, authenticated, login } = usePrivy();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Vault picker state.
  const [vaults, setVaults] = useState<VaultOption[]>([]);
  const [vaultsLoading, setVaultsLoading] = useState(false);
  const [selectedVault, setSelectedVault] = useState<VaultOption | null>(null);

  // Friend search state.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FriendResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<FriendResult[]>([]);

  // Load vaults from LI.FI Earn API on mount.
  useEffect(() => {
    if (!ready || !authenticated) return;
    let cancelled = false;
    setVaultsLoading(true);
    (async () => {
      try {
        const data = await authedFetch<{ vaults: VaultOption[] }>(
          "/api/earn/vaults?chainId=8453&asset=USDC&limit=10",
        );
        if (!cancelled) {
          setVaults(data.vaults);
          if (data.vaults.length > 0) setSelectedVault(data.vaults[0]);
        }
      } catch {
        // Non-critical — will fall back to env default.
      } finally {
        if (!cancelled) setVaultsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ready, authenticated]);

  // Debounced friend search.
  useEffect(() => {
    if (!authenticated) return;
    if (!query.trim() || query.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const data = await authedFetch<{ users: FriendResult[] }>(
          `/api/friends/search?q=${encodeURIComponent(query)}`,
        );
        if (!cancelled) {
          const pickedIds = new Set(picked.map((p) => p.id));
          setResults(data.users.filter((u) => !pickedIds.has(u.id)));
        }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, authenticated, picked]);

  if (!ready) return <p>Loading...</p>;
  if (!authenticated) {
    return (
      <div className="flex flex-col gap-3">
        <p>You need to sign in before creating a group.</p>
        <div>
          <button onClick={() => login()}>Sign in</button>
        </div>
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Group name is required.");
      return;
    }
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        name: trimmed,
        memberIds: picked.map((p) => p.id),
      };
      if (selectedVault) {
        payload.vaultAddress = selectedVault.address;
        payload.vaultChainId = selectedVault.chainId;
      }
      const group = await authedFetch<CreatedGroup>("/api/groups", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      router.push(`/groups/${group.id}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="field-row-stacked">
        <label htmlFor="group-name">Group name</label>
        <input
          id="group-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          disabled={submitting}
          placeholder="Friday Night Degens"
        />
      </div>

      {/* Yield strategy picker */}
      <fieldset>
        <legend>Yield strategy (LI.FI Earn)</legend>
        {vaultsLoading ? (
          <p className="text-xs">Loading yield opportunities...</p>
        ) : vaults.length === 0 ? (
          <p className="text-xs">Using default Morpho USDC vault on Base.</p>
        ) : (
          <div
            className="sunken-panel"
            style={{ maxHeight: 180, overflowY: "auto" }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #808080" }}>
                  <th style={{ padding: "2px 6px" }}></th>
                  <th style={{ padding: "2px 6px" }}>Protocol</th>
                  <th style={{ padding: "2px 6px" }}>APY</th>
                  <th style={{ padding: "2px 6px" }}>TVL</th>
                </tr>
              </thead>
              <tbody>
                {vaults.map((v) => {
                  const isSelected = selectedVault?.address === v.address;
                  return (
                    <tr
                      key={v.address}
                      onClick={() => setSelectedVault(v)}
                      style={{
                        cursor: "pointer",
                        background: isSelected ? "#000080" : "transparent",
                        color: isSelected ? "#fff" : "inherit",
                      }}
                    >
                      <td style={{ padding: "3px 6px", width: 20 }}>
                        <input
                          type="radio"
                          name="vault"
                          checked={isSelected}
                          onChange={() => setSelectedVault(v)}
                          style={{ margin: 0 }}
                        />
                      </td>
                      <td style={{ padding: "3px 6px" }}>
                        {v.protocol}
                        {v.name && (
                          <span style={{ opacity: 0.7, marginLeft: 4 }}>
                            {v.name.length > 25 ? v.name.slice(0, 25) + "..." : v.name}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "3px 6px", fontWeight: 700 }}>
                        {fmtApy(v.apy)}
                      </td>
                      <td style={{ padding: "3px 6px", opacity: 0.7 }}>
                        {fmtTvl(v.tvl_usd)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {selectedVault && (
          <p className="text-xs" style={{ marginTop: 4, opacity: 0.8 }}>
            Idle funds earn {fmtApy(selectedVault.apy)} via {selectedVault.protocol} on{" "}
            {selectedVault.asset}. Powered by LI.FI Earn.
          </p>
        )}
      </fieldset>

      {/* Friend search */}
      <div className="field-row-stacked">
        <label htmlFor="friend-search">Add friends (optional)</label>
        <input
          id="friend-search"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="name, ENS, basename, or 0x..."
          disabled={submitting}
        />
      </div>

      {searching && <p className="text-xs">Searching...</p>}
      {results.length > 0 && (
        <div className="sunken-panel" style={{ maxHeight: 140, overflowY: "auto" }}>
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {results.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => {
                    setPicked((prev) => [...prev, r]);
                    setResults((prev) => prev.filter((x) => x.id !== r.id));
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    padding: "4px 8px",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  {friendLabel(r)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {picked.length > 0 && (
        <div className="text-xs">
          <strong>Members:</strong>{" "}
          {picked.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ", "}
              {friendLabel(p)}
              <button
                type="button"
                onClick={() => setPicked((prev) => prev.filter((x) => x.id !== p.id))}
                aria-label={`Remove ${friendLabel(p)}`}
                style={{ marginLeft: 4, padding: "0 4px", fontSize: 10 }}
              >
                x
              </button>
            </span>
          ))}
        </div>
      )}

      <p className="text-xs">
        You&apos;ll be added automatically. People not on BetPal yet can join via
        an invite link after the group is created.
      </p>

      {error && (
        <p className="text-xs" role="alert" style={{ color: "#a00" }}>
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={submitting}>
          {submitting ? "Creating..." : "Create group"}
        </button>
        <button type="button" onClick={() => router.back()} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  );
}
