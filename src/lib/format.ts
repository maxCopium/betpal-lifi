/**
 * Shared formatting helpers for display.
 * No "server-only" — safe for both client and server.
 */

/** Format integer cents as USD currency string. */
export function fmtCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

/** Truncate an address to 0x1234…abcd form. */
export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Format APY decimal (0.05 = 5%) as percentage string. */
export function fmtApy(apy: number | null): string {
  if (apy === null) return "-- %";
  return `${(apy * 100).toFixed(2)}%`;
}

/** Format an ISO date to "Apr 12, 3:00 PM" form. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    ", " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  );
}
