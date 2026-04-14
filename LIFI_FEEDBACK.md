# LI.FI Feedback — BetPal (DeFi Mullet Hackathon)

Concise notes on what worked vs. what surprised us. Scope: only things LI.FI
controls (API, Composer, Earn).

## What worked well

- **`/quote` with vault as `toToken`** — single signature deposits straight
  into Morpho on Base. This is the keystone feature for us; it removed the
  approve→swap→deposit dance entirely.
- **`/v1/connections`** — fast and cached, perfect for validating "is this
  source token routable into the chosen vault?" before showing it in the UI.
- **`/v1/earn/vaults`** — clean shape, correct decimals, returns enough
  metadata (APY, TVL, protocol) to build a vault picker without hitting
  protocol-specific endpoints.
- **Error JSON shape** — `errors.filteredOut[].reason` gave us actionable
  user messages (e.g. price impact > 10% → "amount too small").
- **MCP server** — `mcp__lifi__*` tools sped up exploration during the build;
  we could ask "is there a route from X→Y" without leaving the editor.
- **Integrator tagging** — straightforward, applied via single query param.

## What didn't 100% match expectations

- **Reverse routes are not symmetric.** `/quote` with the vault token as
  `fromToken` works for some vaults (`bbqUSDC` on Base does not). There's
  no flag on `/v1/earn/vaults` saying "withdrawals are routable via LI.FI",
  so we discover it only by attempting a quote. We had to ship a fallback
  to direct ERC-4626 `redeem` + `USDC.transfer`. A boolean like
  `withdrawalRoutable` (or a list of supported exit tokens) on the vault
  metadata would have saved a chunk of hairy fallback code.
- **`/quote/toAmount` (reverse quote)** can return a route that reverts
  on-chain. We expected "if a route is returned, simulation passed." For
  the dust amounts typical in tests the reverse quote sometimes routed
  through pools that wouldn't actually fill. A pre-flight simulation in
  the API (or an explicit "simulated" flag in the response) would prevent
  this class of failure.
- **`estimate.fromAmount` typing** is loose — we had to widen the zod
  schema with `.passthrough()` and then re-cast it. A documented, typed
  field for the input amount on reverse quotes would help.
- **Vault rounding mismatch.** `convertToShares(usdcAmount)` predicts
  shares, but `redeem(shares)` can yield 1 unit less USDC than the
  prediction. Not strictly LI.FI's problem, but if Composer's reverse
  route handled the +1-wei buffer internally for us we wouldn't have hit
  the ERC20 "transfer amount exceeds balance" revert.
- **Gas estimate from `transactionRequest.gasLimit`** runs hot for
  Composer txs. Privy's default `maxFeePerGas` × that gas limit demanded
  ~0.003 ETH upfront on Base, even though actual execution costs <$0.10.
  We had to set explicit EIP-1559 caps from the current Base block to
  make withdrawals feasible from a thinly-funded custodial wallet. A
  recommended `maxFeePerGas` field in the response (or per-chain guidance
  in the docs) would prevent everyone from re-discovering this.
- **No webhook / push for `/status`** — we poll, which is fine, but for
  long bridges a webhook would let us drop the cron entirely.
- **Earn vault APY field semantics** — we got bitten by "is this 0.05 or
  5 or 5.0%?" The answer turned out to be percentage-units (4.68 = 4.68%)
  but the docs example we saw used decimal. One-line clarification in
  `/v1/earn/vaults` reference would help.

## Nice-to-haves

- Vault-level `withdrawalRoutable: bool` on `/v1/earn/vaults`.
- Reverse quote: simulate before returning, or expose a `simulated` flag.
- Per-chain recommended `maxFeePerGas` in `/quote` responses.
- Webhook delivery for `/status` terminal states.
