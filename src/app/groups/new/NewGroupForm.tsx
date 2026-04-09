"use client";

/**
 * NewGroupForm — Win98-styled form for creating a betting group.
 *
 * Adds debounced friend search so members can be added at creation time.
 * Picked friends are tracked in a local Set; the form posts their BetPal
 * users.id values as `memberIds`. Invite-link flow is still available
 * post-creation for anyone not yet on BetPal.
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

function friendLabel(f: FriendResult): string {
  return (
    f.display_name ||
    f.ens_name ||
    f.basename ||
    `${f.wallet_address.slice(0, 6)}…${f.wallet_address.slice(-4)}`
  );
}

export function NewGroupForm() {
  const router = useRouter();
  const { ready, authenticated, login } = usePrivy();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Friend search state.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FriendResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<FriendResult[]>([]);

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
          // Filter out anyone already picked.
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

  if (!ready) return <p>Loading…</p>;
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
      const group = await authedFetch<CreatedGroup>("/api/groups", {
        method: "POST",
        body: JSON.stringify({
          name: trimmed,
          memberIds: picked.map((p) => p.id),
        }),
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

      <div className="field-row-stacked">
        <label htmlFor="friend-search">Add friends (optional)</label>
        <input
          id="friend-search"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="name, ENS, basename, or 0x…"
          disabled={submitting}
        />
      </div>

      {searching && <p className="text-xs">Searching…</p>}
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
                style={{
                  marginLeft: 4,
                  padding: "0 4px",
                  fontSize: 10,
                }}
              >
                ×
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
          {submitting ? "Creating…" : "Create group"}
        </button>
        <button type="button" onClick={() => router.back()} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  );
}
