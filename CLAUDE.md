@AGENTS.md

<!-- BEGIN:backlog -->
# Known Gaps (see BACKLOG.md for full detail)

## P0 — Nothing works without these
- **Env vars**: 13 vars in `.env.local` are empty (Privy, Supabase, LI.FI, resolver keypair, Morpho vault, cron secret)
- **Database**: `supabase/schema.sql` not yet applied — run via SQL Editor or `npm run db:apply` (see `supabase/README.md`)
- **Cron not scheduled**: no `vercel.json` cron config; `/api/cron/resolve-bets` must be triggered manually

## P1 — Happy path blockers
- **Phase 3 deposit confirm**: no integration test; a failed confirm leaves a transaction stuck in `executing`
- **Bet settlement**: `resolveBet.ts` → cron → ledger payouts has zero integration test coverage
- **Withdrawal expiry reversal**: no test, no automated trigger
- **Safe lazy deploy**: Safe only materialises on-chain after first Phase 3 deposit; tests that run Safe ops before that will fail

## P2 — Beta gaps
- **No integration tests** on deposit state machine, bet settlement, or cron worker
- **Post-deposit invites**: owner-add re-invite flow not wired (UI + API)
- **Member list**: `GroupDashboard.tsx` doesn't render members (API supports it)
- **`earn.ts` stub**: LI.FI Earn wrapper incomplete; `MORPHO_USDC_VAULT_BASE` must be hardcoded

## P3 — Polish
- Demo mode (`NEXT_PUBLIC_BETPAL_DEMO_MODE`) partially wired
- Add `vercel.json` with hourly cron for `/api/cron/resolve-bets`
<!-- END:backlog -->
