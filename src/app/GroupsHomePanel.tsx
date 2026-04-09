"use client";

/**
 * GroupsHomePanel — the authenticated user's group list, embedded on the home
 * page. Shows a "Create new group" CTA + a list of existing groups with quick
 * links into each. Falls back to a friendly message if not signed in.
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

  if (!ready) return <p className="text-xs">Loading…</p>;
  if (!authenticated) {
    return <p className="text-xs">Sign in to see your groups.</p>;
  }
  if (error) {
    return (
      <p className="text-xs" style={{ color: "#a00" }}>
        {error}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Link href="/groups/new">
          <button>+ New group</button>
        </Link>
      </div>
      {groups === null ? (
        <p className="text-xs">Loading groups…</p>
      ) : groups.length === 0 ? (
        <p className="text-xs">No groups yet — create one to get started.</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {groups.map((g) => (
            <li key={g.id} style={{ padding: "2px 0" }}>
              <Link
                href={`/groups/${g.id}`}
                style={{ color: "#000080", fontSize: 12 }}
              >
                {g.name}
              </Link>
              <span className="text-xs" style={{ opacity: 0.7 }}>
                {" "}
                · {g.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
