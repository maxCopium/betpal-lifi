"use client";

/**
 * <Sidebar> — Win98 Explorer-style left pane with tree navigation.
 *
 * Shows:
 *   - Home (My Computer)
 *   - New Group
 *   - User's groups (expandable, shows bets when on a group/bet page)
 */
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { authedFetch } from "@/lib/clientFetch";

type GroupSummary = { id: string; name: string; status: string };
type BetSummary = { id: string; title: string; status: string };

export function Sidebar() {
  const { ready, authenticated } = usePrivy();
  const pathname = usePathname();
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [bets, setBets] = useState<Record<string, BetSummary[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const groupMatch = pathname.match(/\/groups\/([a-f0-9-]+)/);
  const betMatch = pathname.match(/\/bets\/([a-f0-9-]+)/);
  const activeGroupId = groupMatch?.[1] ?? null;
  const activeBetId = betMatch?.[1] ?? null;

  useEffect(() => {
    if (!ready || !authenticated) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await authedFetch<{
          groups: { group: GroupSummary | null }[];
        }>("/api/groups");
        if (cancelled) return;
        const flat = data.groups
          .map((g) => g.group)
          .filter((g): g is GroupSummary => g !== null);
        setGroups(flat);
      } catch {
        // Non-critical nav — fail silently.
      }
    })();
    return () => { cancelled = true; };
  }, [ready, authenticated]);

  useEffect(() => {
    if (!activeGroupId || !ready || !authenticated) return;
    setExpanded((s) => new Set(s).add(activeGroupId));
    if (bets[activeGroupId]) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await authedFetch<{ bets: BetSummary[] }>(
          `/api/groups/${activeGroupId}/bets`,
        );
        if (!cancelled) setBets((b) => ({ ...b, [activeGroupId]: data.bets }));
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [activeGroupId, ready, authenticated, bets]);

  useEffect(() => {
    if (!activeBetId || !ready || !authenticated) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await authedFetch<{ bet: { group_id: string } }>(
          `/api/bets/${activeBetId}`,
        );
        if (cancelled) return;
        const gid = data.bet.group_id;
        setExpanded((s) => new Set(s).add(gid));
        if (!bets[gid]) {
          const bData = await authedFetch<{ bets: BetSummary[] }>(
            `/api/groups/${gid}/bets`,
          );
          if (!cancelled) setBets((b) => ({ ...b, [gid]: bData.bets }));
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [activeBetId, ready, authenticated, bets]);

  function toggleGroup(gid: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });
    if (!bets[gid] && ready && authenticated) {
      (async () => {
        try {
          const data = await authedFetch<{ bets: BetSummary[] }>(
            `/api/groups/${gid}/bets`,
          );
          setBets((b) => ({ ...b, [gid]: data.bets }));
        } catch {}
      })();
    }
  }

  const isHome = pathname === "/";
  const isNewGroup = pathname === "/groups/new";

  return (
    <div className="betpal-sidebar">
      <div className="window" style={{ height: "100%" }}>
        <div className="title-bar">
          <div className="title-bar-text">Explorer</div>
        </div>
        <div className="window-body">
          <ul className="tree-view" style={{ margin: 0 }}>
            {/* Home */}
            <li>
              <Link
                href="/"
                className="betpal-nav-link"
                style={{ fontWeight: isHome ? 700 : 400 }}
              >
                💻 My Computer
              </Link>
            </li>

            {/* New Group */}
            <li>
              <Link
                href="/groups/new"
                className="betpal-nav-link"
                style={{ fontWeight: isNewGroup ? 700 : 400 }}
              >
                ➕ New Group
              </Link>
            </li>

            {/* Groups */}
            {groups.length > 0 && (
              <li>
                <span style={{ opacity: 0.5, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  Groups
                </span>
                <ul>
                  {groups.map((g) => {
                    const isActiveGroup = activeGroupId === g.id;
                    const isExpanded = expanded.has(g.id);
                    const groupBets = bets[g.id] ?? [];
                    return (
                      <li key={g.id} className={isExpanded ? "" : "collapsed"}>
                        <span
                          onClick={() => toggleGroup(g.id)}
                          style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}
                        >
                          <span style={{ fontSize: 10, transition: "transform 0.15s", transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", display: "inline-block", flexShrink: 0 }}>
                            ▶
                          </span>
                          <span style={{ flexShrink: 0 }}>📁</span>
                          <Link
                            href={`/groups/${g.id}`}
                            className="betpal-nav-link"
                            style={{ fontWeight: isActiveGroup ? 700 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          >
                            {g.name}
                          </Link>
                          <span style={{ marginLeft: "auto", opacity: 0.5, fontSize: 11, flexShrink: 0 }}>
                            {g.status}
                          </span>
                        </span>
                        {isExpanded && (
                          <ul>
                            {groupBets.length === 0 ? (
                              <li>
                                <span style={{ opacity: 0.5, fontStyle: "italic" }}>
                                  no bets yet
                                </span>
                              </li>
                            ) : (
                              groupBets.map((bet) => {
                                const isActiveBet = activeBetId === bet.id;
                                return (
                                  <li key={bet.id} style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
                                    <Link
                                      href={`/bets/${bet.id}`}
                                      className="betpal-nav-link"
                                      style={{ fontWeight: isActiveBet ? 700 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}
                                    >
                                      📄 {bet.title.length > 25
                                        ? bet.title.slice(0, 25) + "…"
                                        : bet.title}
                                    </Link>
                                    <span style={{ opacity: 0.5, fontSize: 11, flexShrink: 0 }}>
                                      {bet.status}
                                    </span>
                                  </li>
                                );
                              })
                            )}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
