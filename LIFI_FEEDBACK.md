# LI.FI Feedback — BetPal (DeFi Mullet Hackathon)

Concise, honest notes from building BetPal. Scope: only things LI.FI
controls. Items below were observed first-hand during development;
speculation has been left out.

## What worked well

- **`/quote` with the vault address as `toToken`** — single-signature
  deposits straight into the Morpho ERC-4626 vault on Base. This is the
  keystone feature for us; it removed the approve→swap→deposit dance
  entirely and is the reason we built around Composer at all.
- **`/v1/connections`** — fast, cached, and the right shape for
  pre-validating "is this source token routable into the chosen vault?"
  before showing it in the UI.
- **`/v1/earn/vaults`** — gave us enough metadata (APY, TVL, protocol,
  decimals) to build a vault picker without touching protocol-specific
  endpoints.
- **Error JSON shape** — `errors.filteredOut[].reason` was structured
  enough to map directly to a user-facing message (we surface "amount
  too small — swap price impact exceeds 10%" verbatim from there).
- **MCP server** (`mcp__lifi__*`) — sped up exploration during the
  build; we could ask "is there a route from X→Y" without leaving the
  editor.
- **Integrator tagging** — straightforward, single query param.

## What didn't 100% match expectations

- **No way to know up-front whether a vault is withdrawal-routable.**
  `/v1/earn/vaults` tells us a vault exists and its APY, but doesn't say
  whether LI.FI has a return route from the vault token back to USDC.
  We discovered this only by attempting `/quote/toAmount` with the vault
  token as `fromToken` and getting "None of the available routes could
  successfully generate a tx" — repeatedly, for the same vault. We had
  to ship a fallback to direct ERC-4626 `redeem` + `USDC.transfer`. A
  boolean on the vault metadata (`withdrawalRoutable`, or a list of
  supported exit tokens) would have prevented the entire fallback.

- **`estimate.fromAmount` is undocumented / loosely typed on the reverse
  quote.** When calling `/quote/toAmount` we need the required input
  amount, which lives at `estimate.fromAmount`, but it's not in any
  TypeScript / OpenAPI shape we could find. Our zod schema had to use
  `.passthrough()` and we cast it manually. A documented, typed field
  would help.

- **Earn vault APY field — unit ambiguity.** We got bitten by "is this
  `0.05`, `5`, or `5.0%`?". The answer (for the vaults we used) is
  percentage units (`4.68` = 4.68%), but it took two passes through our
  formatter to get right. One sentence in the `/v1/earn/vaults` reference
  would prevent this for everyone.

## Nice-to-haves

- Vault-level `withdrawalRoutable: bool` (or supported exit tokens) on
  `/v1/earn/vaults`.
- Document `estimate.fromAmount` on the `/quote/toAmount` response.
- One-line APY unit clarification in `/v1/earn/vaults`.
