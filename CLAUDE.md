@AGENTS.md

# Architecture

BetPal uses **Privy server wallets** for per-group custodial wallets. Each group gets its own
Privy-managed wallet created via `privy().walletApi.createWallet()`. The app signs all on-chain
transactions (vault redemptions, USDC transfers) via the Privy wallet API — no local private keys.

The `safe_address` column in the DB is a **legacy name** — it stores the wallet address.
The `privy_wallet_id` column stores the Privy wallet ID used for signing.
Do not introduce Safe/multisig logic or local key derivation.

# Known Gaps (see BACKLOG.md for full detail)

## P0 — Nothing works without these
- **Env vars**: 11 vars in `.env.local` are empty (Privy, Supabase, LI.FI, Morpho vault, cron secret)
- **Database**: `supabase/schema.sql` not yet applied — run via SQL Editor or `npm run db:apply` (see `supabase/README.md`)
- **Cron not scheduled**: no `vercel.json` cron config; `/api/cron/resolve-bets` must be triggered manually

## P1 — Happy path blockers
- **Phase 3 deposit confirm**: no integration test; a failed confirm leaves a transaction stuck in `executing`
- **Bet settlement**: `resolveBet.ts` → cron → ledger payouts has zero integration test coverage
- **Withdrawal reversal**: if on-chain withdrawal fails after ledger debit, reversal is automatic but untested

## P2 — Beta gaps
- **No integration tests** on deposit state machine, bet settlement, or cron worker
- **Member list**: `GroupDashboard.tsx` doesn't render members (API supports it)
- **`earn.ts` stub**: LI.FI Earn wrapper incomplete; `MORPHO_USDC_VAULT_BASE` must be hardcoded

## P3 — Polish
- Demo mode (`NEXT_PUBLIC_BETPAL_DEMO_MODE`) partially wired
- Add `vercel.json` with hourly cron for `/api/cron/resolve-bets`
- Rename `safe_address` DB column to `wallet_address` (cosmetic, requires migration)
