"use client";

/**
 * GroupsHomePanel — the authenticated user's group list on the home page.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { authedFetch } from "@/lib/clientFetch";

type GroupSummary = {
  id: string;
  name: string;
  status: string;
};

type ListResponse = {
  groups: { role: string; group: GroupSummary | null }[];
};

export function GroupsHomePanel() {
  const { ready, authenticated } = usePrivy();
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !authenticated) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await authedFetch<ListResponse>("/api/groups");
        if (cancelled) return;
        const flat = data.groups
          .map((g) => g.group)
          .filter((g): g is GroupSummary => g !== null);
        setGroups(flat);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, authenticated]);

  if (!ready) return <p style={{ opacity: 0.6 }}>Loading…</p>;
  if (!authenticated) {
    return <p style={{ opacity: 0.6 }}>Sign in to see your groups.</p>;
  }
  if (error) {
    return <div className="betpal-alert betpal-alert--error">{error}</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <strong>Your groups</strong>
        <Link href="/groups/new">
          <button>+ Group</button>
        </Link>
      </div>
      {groups === null ? (
        <p style={{ opacity: 0.6 }}>Loading groups…</p>
      ) : groups.length === 0 ? (
        <p style={{ opacity: 0.6, fontStyle: "italic" }}>No groups yet — create one to get started.</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {groups.map((g) => (
            <li key={g.id} className="betpal-list-item">
              <Link href={`/groups/${g.id}`} style={{ fontWeight: 500 }}>
                {g.name}
              </Link>
              <span style={{ opacity: 0.6, marginLeft: 8 }}>
                {g.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
