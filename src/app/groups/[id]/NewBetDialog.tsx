"use client";

/**
 * NewBetDialog — Win98 modal for creating a bet from a Polymarket market.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/lib/clientFetch";

type SearchResult = {
  id: string;
  question: string;
  slug: string | null;
  end_date: string | null;
  closed: boolean;
};

type CreatedBet = { id: string };

const HOURS_24 = 24 * 60 * 60 * 1000;

function defaultJoinDeadline(): string {
  return new Date(Date.now() + HOURS_24).toISOString().slice(0, 16);
}

export function NewBetDialog({
  open,
  groupId,
  onClose,
  onCreated,
}: {
  open: boolean;
  groupId: string;
  onClose: () => void;
  onCreated: (betId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [trending, setTrending] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [picked, setPicked] = useState<SearchResult | null>(null);
  const [joinDeadline, setJoinDeadline] = useState(defaultJoinDeadline);
  const [stakeAmountUsd, setStakeAmountUsd] = useState("5");
  const [maxParticipants, setMaxParticipants] = useState("");
  const [startWhenFull, setStartWhenFull] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await authedFetch<{ markets: SearchResult[] }>(
          "/api/polymarket/trending?limit=10",
        );
        if (!cancelled) setTrending(data.markets);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!query.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const data = await authedFetch<{ markets: SearchResult[] }>(
          `/api/polymarket/search?q=${encodeURIComponent(query)}&limit=15`,
        );
        if (!cancelled) setResults(data.markets);
      } catch (e) {
        if (!cancelled) setSearchError((e as Error).message);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, open]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setTrending([]);
      setPicked(null);
      setError(null);
      setJoinDeadline(defaultJoinDeadline());
      setStakeAmountUsd("5");
    }
  }, [open]);

  if (!open) return null;

  const displayList = query.trim() ? results : trending;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!picked) {
      setError("Pick a market first.");
      return;
    }
    setSubmitting(true);
    try {
      const cents = Math.round(parseFloat(stakeAmountUsd) * 100);
      if (!Number.isFinite(cents) || cents < 1) {
        setError("Stake must be at least $0.01");
        return;
      }
      const maxP = maxParticipants ? parseInt(maxParticipants, 10) : undefined;
      const swf = startWhenFull && maxP != null;

      const payload: Record<string, unknown> = {
        polymarket_market_id: picked.id,
        stake_amount_cents: cents,
      };
      if (!swf || joinDeadline) {
        payload.join_deadline = new Date(joinDeadline).toISOString();
      }
      if (maxP != null && maxP >= 2) payload.max_participants = maxP;
      if (swf) payload.start_when_full = true;

      const bet = await authedFetch<CreatedBet>(`/api/groups/${groupId}/bets`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      onCreated(bet.id);
      onClose();
      router.push(`/bets/${bet.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.35)", zIndex: 50 }}
      role="dialog"
      aria-modal="true"
      aria-label="New bet"
    >
      <div className="window" style={{ width: 560, maxWidth: "94vw" }}>
        <div className="title-bar">
          <div className="title-bar-text">+ Bet</div>
          <div className="title-bar-controls">
            <button aria-label="Close" onClick={onClose} />
          </div>
        </div>
        <div className="window-body">
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <div className="field-row-stacked" style={{ gap: 4 }}>
              <label htmlFor="bet-search">Search Polymarket markets</label>
              <input
                id="bet-search"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. bitcoin, election, fed rate"
              />
            </div>

            {searching && <p style={{ opacity: 0.6 }}>Searching…</p>}
            {searchError && (
              <div className="betpal-alert betpal-alert--error">{searchError}</div>
            )}

            <div
              className="sunken-panel"
              style={{ maxHeight: 260, overflowY: "auto" }}
            >
              {!query.trim() && trending.length > 0 && (
                <p style={{ padding: "6px 10px", opacity: 0.5, margin: 0, fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  Trending on Polymarket
                </p>
              )}
              {displayList.length === 0 && !searching && (
                <p style={{ padding: 12, opacity: 0.6, fontStyle: "italic" }}>
                  {query ? "No matches." : "Loading trending..."}
                </p>
              )}
              <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {displayList.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setPicked(r)}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        background: picked?.id === r.id ? "#000080" : "transparent",
                        color: picked?.id === r.id ? "#fff" : "inherit",
                        border: "none",
                        padding: "8px 10px",
                        cursor: "pointer",
                        borderBottom: "1px solid #eee",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => {
                        if (picked?.id !== r.id) e.currentTarget.style.background = "rgba(0,0,128,0.06)";
                      }}
                      onMouseLeave={(e) => {
                        if (picked?.id !== r.id) e.currentTarget.style.background = "transparent";
                      }}
                    >
                      {r.question}
                      {r.end_date && (
                        <span style={{ opacity: 0.7, marginLeft: 8 }}>
                          ends {new Date(r.end_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            {picked && (
              <div className="betpal-alert betpal-alert--info">
                <strong>Selected:</strong> {picked.question}
              </div>
            )}

            <div style={{ display: "flex", gap: 12 }}>
              <div className="field-row-stacked" style={{ gap: 4, flex: 1 }}>
                <label htmlFor="bet-deadline">Join deadline</label>
                <input
                  id="bet-deadline"
                  type="datetime-local"
                  value={joinDeadline}
                  onChange={(e) => setJoinDeadline(e.target.value)}
                />
              </div>
              <div className="field-row-stacked" style={{ gap: 4, width: 120 }}>
                <label htmlFor="bet-stake">Stake (USD)</label>
                <input
                  id="bet-stake"
                  type="text"
                  inputMode="decimal"
                  value={stakeAmountUsd}
                  onChange={(e) => setStakeAmountUsd(e.target.value)}
                  placeholder="5.00"
                />
              </div>
            </div>
            <p style={{ margin: 0, fontSize: 11, opacity: 0.6 }}>
              Everyone pays the same stake. Winners split the pot equally.
            </p>

            <details
              open={showAdvanced}
              onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
              style={{ fontSize: 12 }}
            >
              <summary style={{ cursor: "pointer", opacity: 0.7 }}>Advanced options</summary>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                <div className="field-row-stacked" style={{ gap: 4 }}>
                  <label htmlFor="bet-max">Max participants</label>
                  <input
                    id="bet-max"
                    type="number"
                    min="2"
                    max="100"
                    value={maxParticipants}
                    onChange={(e) => setMaxParticipants(e.target.value)}
                    placeholder="Unlimited"
                    style={{ width: 120 }}
                  />
                </div>
                {maxParticipants && parseInt(maxParticipants, 10) >= 2 && (
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={startWhenFull}
                      onChange={(e) => setStartWhenFull(e.target.checked)}
                    />
                    Start when full (lock bet when all slots fill)
                  </label>
                )}
                {startWhenFull && maxParticipants && (
                  <p style={{ margin: 0, fontSize: 11, opacity: 0.6 }}>
                    Bet will lock automatically when {maxParticipants} people have joined. Join deadline is optional as a fallback.
                  </p>
                )}
              </div>
            </details>

            {error && (
              <div className="betpal-alert betpal-alert--error" role="alert">{error}</div>
            )}

            <div className="flex gap-2 justify-end" style={{ paddingTop: 4 }}>
              <button type="button" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button type="submit" disabled={submitting || !picked}>
                {submitting ? "Creating…" : "Create bet"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
