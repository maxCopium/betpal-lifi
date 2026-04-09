"use client";

/**
 * NewBetDialog — Win98 modal for creating a bet from a Polymarket market.
 *
 * Flow:
 *   1. User types a search query → GET /api/polymarket/search
 *   2. User picks a market from the result list
 *   3. User picks a join deadline (default: 24h from now, capped on the
 *      server to be < market end)
 *   4. POST /api/groups/[id]/bets
 *   5. On success, call onCreated(betId) so the parent can refresh.
 *
 * Search is debounced (~350ms) to keep Polymarket happy.
 */
import { useEffect, useState } from "react";
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
  return new Date(Date.now() + HOURS_24).toISOString().slice(0, 16); // for datetime-local
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
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [picked, setPicked] = useState<SearchResult | null>(null);
  const [joinDeadline, setJoinDeadline] = useState(defaultJoinDeadline);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounced search.
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

  // Reset state on each open.
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setPicked(null);
      setError(null);
      setJoinDeadline(defaultJoinDeadline());
    }
  }, [open]);

  if (!open) return null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!picked) {
      setError("Pick a market first.");
      return;
    }
    setSubmitting(true);
    try {
      const iso = new Date(joinDeadline).toISOString();
      const bet = await authedFetch<CreatedBet>(`/api/groups/${groupId}/bets`, {
        method: "POST",
        body: JSON.stringify({
          polymarket_market_id: picked.id,
          join_deadline: iso,
        }),
      });
      onCreated(bet.id);
      onClose();
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
      <div className="window" style={{ width: 540, maxWidth: "92vw" }}>
        <div className="title-bar">
          <div className="title-bar-text">New Bet</div>
          <div className="title-bar-controls">
            <button aria-label="Close" onClick={onClose} />
          </div>
        </div>
        <div className="window-body">
          <form onSubmit={onSubmit} className="flex flex-col gap-2">
            <div className="field-row-stacked">
              <label htmlFor="bet-search">Search Polymarket markets</label>
              <input
                id="bet-search"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. bitcoin, election, fed rate"
              />
            </div>

            {searching && <p className="text-xs">Searching…</p>}
            {searchError && (
              <p className="text-xs" style={{ color: "#a00" }}>
                {searchError}
              </p>
            )}

            <div
              className="sunken-panel"
              style={{ maxHeight: 200, overflowY: "auto" }}
            >
              {results.length === 0 && !searching && (
                <p className="text-xs" style={{ padding: 8 }}>
                  {query ? "No matches." : "Type a query to search."}
                </p>
              )}
              <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {results.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setPicked(r)}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        background:
                          picked?.id === r.id ? "#000080" : "transparent",
                        color: picked?.id === r.id ? "#fff" : "inherit",
                        border: "none",
                        padding: "4px 8px",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      {r.question}
                      {r.end_date && (
                        <span style={{ opacity: 0.7 }}>
                          {" "}
                          · ends {new Date(r.end_date).toLocaleDateString()}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="field-row-stacked">
              <label htmlFor="bet-deadline">Join deadline</label>
              <input
                id="bet-deadline"
                type="datetime-local"
                value={joinDeadline}
                onChange={(e) => setJoinDeadline(e.target.value)}
              />
            </div>

            {picked && (
              <p className="text-xs" style={{ opacity: 0.8 }}>
                Selected: {picked.question}
              </p>
            )}
            {error && (
              <p className="text-xs" role="alert" style={{ color: "#a00" }}>
                {error}
              </p>
            )}

            <div className="flex gap-2 justify-end">
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
