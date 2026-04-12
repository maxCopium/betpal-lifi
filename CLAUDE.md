@AGENTS.md

# Architecture

BetPal uses **Privy server wallets** for per-group custodial wallets. Each group gets its own
Privy-managed wallet created via `privy().walletApi.createWallet()`. The app signs all on-chain
transactions (vault redemptions, USDC transfers) via the Privy wallet API — no local private keys.

The `wallet_address` column in the `groups` table stores the group's custodial wallet address.
The `privy_wallet_id` column stores the Privy wallet ID used for signing.
Do not introduce Safe/multisig logic or local key derivation.

## On-chain flow

- **Deposits**: User-signed via LI.FI Composer. Composer handles swap + approve + vault.deposit() atomically into the Morpho ERC-4626 vault. Group wallet is the `toAddress`.
- **Withdrawals/Payouts**: Server-signed via Privy wallet API. `vault.redeem()` → USDC to group wallet → `USDC.transfer()` → user wallet. Both txs signed by Privy server wallet.
- **Yield**: USDC sits in Morpho the entire time. Yield accrues as extra vault shares. On resolution, winners get principal + their share of yield.

## Betting model

Equal-stakes pari-mutuel. Fixed stake per bet, winners split pool equally. Polymarket is the oracle
(read resolution status only, never buy positions). Stakes and bets are ledger-only — no on-chain tx
when placing a bet.

## Resolution

- **Lazy resolution**: Server fires `resolveBetIfPossible()` on bet detail/list GET when past deadline.
- **Daily cron**: `/api/cron/resolve-bets` as fallback (Vercel Hobby plan limits to daily).
- **Mock markets**: `mock:` prefix on market_id. Resolved via taskbar button → `POST /api/bets/[id]/mock-resolve`.
- **Auto-payout**: After resolution, `redeemFromVault()` sends USDC to each winner's wallet. If on-chain fails, ledger credit stands — winner can manually withdraw.

## Key conventions

- All money is integer cents (USD-equivalent), never floats.
- `balance_events` is append-only and is the source of truth for the ledger.
- Every event has an `idempotency_key` unique constraint.
- USDC on Base: 6 decimals. 1 cent = 10,000 base units.
- Base L2 gas: ~$0.04/tx. Group wallets need dust ETH for gas.

# Remaining

- **Live smoke test**: No E2E test against deployed app yet — only remaining P0 item.
