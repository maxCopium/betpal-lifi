# BetPal — Backlog

Status as of April 12, 2026. Ordered by what blocks a working demo.

---

## Done (implemented + deployed)

- [x] Per-group Privy server wallets (Safe removed)
- [x] LI.FI Earn vault discovery + APY/TVL display
- [x] LI.FI Composer cross-chain deposits into Morpho vault
- [x] Equal-stakes pari-mutuel betting
- [x] 4-eye vault switching (propose/accept/reject)
- [x] Gas monitoring + dashboard warning
- [x] Lazy bet resolution (page load + daily cron fallback)
- [x] Auto-generated usernames + email censoring
- [x] Live Polymarket odds with manual refresh
- [x] Auto-payout on bet resolution (vault redeem + USDC transfer)
- [x] Unanimous bet cancellation (cancel-vote flow)
- [x] Mock market resolve button in taskbar (demo flow)
- [x] `vercel.json` daily cron for `/api/cron/resolve-bets`
- [x] Database schema applied (all migrations)
- [x] Environment variables configured
- [x] `/api/me` profile endpoint (GET + PATCH display_name)
- [x] 31 API routes, all consumed by frontend

---

## P0 — Must-have for demo

### 1. Fund Privy server wallets with Base ETH
Each group's Privy server wallet needs ~$0.50 of ETH on Base for gas.
Dashboard shows wallet address + gas warning when low.

### 2. Live smoke test
No end-to-end test has been run against the deployed app. The happy path
(create group -> deposit -> bet -> resolve -> auto-payout) needs manual verification.

---

## P1 — Untested paths (risk)

### 3. Phase 3 deposit confirmation
`/api/groups/[id]/deposits/[depositId]/confirm` has no integration test.
A failed confirm leaves a transaction stuck in `executing`.

### 4. Bet settlement integration
`resolveBet.ts` -> cron -> ledger payouts -> auto-payout is untested end-to-end.

### 5. Withdrawal reversal
If `redeemFromVault()` fails after ledger debit, the auto-reversal is untested.

---

## P2 — Beta gaps

### 6. No integration tests on API routes
Only unit tests exist (`amounts.test.ts`, `payouts.test.ts`, `polymarket.test.ts`).

### 7. `earn.ts` LI.FI Earn wrapper incomplete
Dynamic vault discovery path is incomplete. `MORPHO_USDC_VAULT_BASE` is hardcoded.

---

## P3 — Polish

### 8. Demo mode incomplete
`NEXT_PUBLIC_BETPAL_DEMO_MODE=true` not fully wired for offline UI demos.

### 9. Rename `safe_address` column
Legacy name from Gnosis Safe era. Should be `wallet_address`. Cosmetic, requires migration.

---

## DB Setup

See [`supabase/README.md`](supabase/README.md) for full instructions.

```bash
psql "$DATABASE_URL" -f supabase/schema.sql
```

Or paste into the Supabase dashboard SQL editor.
