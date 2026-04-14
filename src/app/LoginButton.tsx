"use client";

import { useCallback, useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { authedFetch } from "@/lib/clientFetch";

function censorEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "****";
  return `${local.slice(0, 2)}***@${domain[0]}***`;
}

type MeResponse = {
  id: string;
  display_name: string | null;
  ens_name: string | null;
  basename: string | null;
  wallet_address: string;
};

export function LoginButton() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const [hidden, setHidden] = useState(false);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const loadMe = useCallback(async () => {
    try {
      const data = await authedFetch<MeResponse>("/api/me");
      setMe(data);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    if (authenticated) void loadMe();
  }, [authenticated, loadMe]);

  async function saveName() {
    if (!draft.trim()) return;
    setSaving(true);
    try {
      const data = await authedFetch<MeResponse>("/api/me", {
        method: "PATCH",
        body: JSON.stringify({ display_name: draft.trim() }),
      });
      setMe(data);
      setEditing(false);
    } catch { /* silent */ }
    setSaving(false);
  }

  if (!ready) return <button disabled>Loading…</button>;

  if (authenticated) {
    const displayName = me?.display_name ?? me?.ens_name ?? me?.basename;
    const email = user?.email?.address;
    const wallet = user?.wallet?.address;
    const identity = hidden
      ? "****"
      : displayName
        ?? (email ? censorEmail(email) : null)
        ?? (wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "user");

    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", width: "100%" }}>
        {editing ? (
          <form
            onSubmit={(e) => { e.preventDefault(); void saveName(); }}
            style={{ display: "flex", gap: 4, alignItems: "center", width: "100%", minWidth: 0 }}
          >
            <input
              type="text"
              placeholder="Username"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={30}
              style={{ flex: 1, minWidth: 0, fontSize: 12 }}
              autoFocus
            />
            <button
              type="submit"
              disabled={saving || !draft.trim()}
              style={{ fontSize: 11, minWidth: 0, padding: "2px 6px" }}
            >
              {saving ? "…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              style={{ fontSize: 11, minWidth: 0, padding: "2px 6px" }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{identity}</strong>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: "auto" }}>
            <button
              type="button"
              onClick={() => { setDraft(me?.display_name ?? ""); setEditing(true); }}
              title="Rename"
              aria-label="Rename"
              style={{
                minHeight: 0,
                minWidth: 0,
                width: 22,
                height: 22,
                padding: 0,
                fontSize: 11,
                lineHeight: 1,
                overflow: "visible",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                boxSizing: "border-box",
              }}
            >
              ✎
            </button>
            <button
              type="button"
              onClick={logout}
              title="Sign out"
              aria-label="Sign out"
              style={{
                minHeight: 0,
                minWidth: 0,
                width: 22,
                height: 22,
                padding: 0,
                fontSize: 11,
                lineHeight: 1,
                overflow: "visible",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                boxSizing: "border-box",
              }}
            >
              ⏻
            </button>
            </span>
          </>
        )}
      </div>
    );
  }

  return <button onClick={login}>Sign in with Privy</button>;
}
