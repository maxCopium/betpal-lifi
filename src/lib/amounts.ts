/**
 * Decimal-string → integer-base-units conversion. Pure, no float math, safe for
 * client and server. Used by deposit + withdraw forms to translate user-typed
 * amounts (e.g. "10.50") into the wei-style integer base units that LI.FI
 * Composer expects (e.g. "10500000" for USDC at 6 decimals).
 *
 * Rejects negative numbers, scientific notation, and anything not matching the
 * `digits[.digits]` shape. Excess fractional precision is silently truncated to
 * `decimals` places (we never round up — losing user money is worse than
 * collecting one cent less than requested).
 */
export function toBaseUnits(amountStr: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("decimals must be a non-negative integer");
  }
  const trimmed = amountStr.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error("invalid amount");
  const [whole, frac = ""] = trimmed.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}
