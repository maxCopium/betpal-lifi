# LI.FI Feedback — BetPal (DeFi Mullet Hackathon)

Concise, honest notes from building BetPal. Scope: only things LI.FI
controls. Items below were observed first-hand during development;
speculation has been left out.

## What worked well

- **`/quote` with the vault address as `toToken`** — the killer feature
  for us. A single signature deposits any source token on any chain
  straight into the Morpho ERC-4626 vault on Base. No approve→swap→
  deposit dance, no per-protocol adapter code, no manual stitching of
  intermediate steps. BetPal's whole "tap to deposit, automatically
  earn yield" UX exists because of this. Without it we wouldn't have
  shipped the yield half of the app in a hackathon timeframe.
- **`/v1/earn/vaults`** — clean, well-typed, returned everything we
  needed (APY, TVL, protocol, token decimals, logos) to build a vault
  picker and a "switch vault" proposal flow without ever hitting
  Morpho directly. The fact that BetPal can list vaults, compare APY,
  and let users vote to migrate is entirely on the back of this one
  endpoint.
- **`/v1/connections`** — fast, cached, exactly the right shape for
  pre-validating "is this source token routable into the chosen
  vault?" before showing it in the deposit UI. Saved us from having
  to handle "no route" errors at submit time.
- **Structured error JSON** — `errors.filteredOut[].reason` was
  detailed enough that we map it directly to a user-facing message.
  Our "amount too small — swap price impact exceeds 10%" toast comes
  verbatim from there. Most APIs make you guess at error semantics
  from a string; this one gave us reasons we could actually act on.
- **MCP server** (`mcp__lifi__*`) — genuinely accelerated the build.
  Being able to ask "what tokens connect Polygon→Base?" or "show me
  Morpho vaults on Base" from the editor, without writing a script
  or hitting the docs, shaved hours off exploration. More API
  vendors should ship MCPs this complete.
- **Integrator tagging** — single query param, zero ceremony.
- **Latency** — `/quote`, `/connections`, and `/earn/vaults` all came
  back fast enough that we never needed to add a loading skeleton on
  the deposit flow. That's rare for a routing API.
- **Docs + reference responses** — most fields had concrete examples,
  which let us hand-build zod schemas in one pass for `/quote`.

Bottom line: Composer is the reason BetPal works. The hard part of
the app — "let users put money in, earn yield, get paid out" — became
a question of calling one endpoint per step instead of integrating
each protocol manually. That's a huge unlock for hackathon-speed
DeFi product work, and we'd reach for LI.FI again immediately.

## What didn't 100% match expectations

- **`isTransactional` / `isRedeemable` are under-documented.** The flags
  exist on the `/v1/earn/vaults` response and are exactly what you want
  for "don't pick a vault I can't round-trip" — but we missed them on a
  first reading of the docs and the example responses we saw didn't
  include them. We ended up auto-selecting `bbqUSDC` (no LI.FI redeem
  route) before discovering we should have been filtering on those
  fields. Calling them out more loudly in the reference — and in the
  picker example — would save everyone else from the same mistake. (To
  LI.FI's credit: the flags are already there. This is a docs issue,
  not a missing-feature issue.)

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

- Put `isTransactional` / `isRedeemable` front and centre in the
  `/v1/earn/vaults` docs, with an explicit "filter on both if you want
  vaults LI.FI can round-trip" note.
- Document `estimate.fromAmount` on the `/quote/toAmount` response.
- One-line APY unit clarification in `/v1/earn/vaults`.
