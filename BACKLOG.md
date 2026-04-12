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

### ~~1. Fund Privy server wallets with Base ETH~~ DONE
Auto gas funding via `ensureGasBestEffort()` before vault ops. POST `/api/groups/[id]/gas`
triggers manual top-up. Set `GAS_FUNDER_PRIVY_WALLET_ID` env var.

### 2. Live smoke test
No end-to-end test has been run against the deployed app. The happy path
(create group -> deposit -> bet -> resolve -> auto-payout) needs manual verification.

---

## P1 — ~~Untested paths~~ Tests added

### ~~3. Phase 3 deposit confirmation~~ DONE
`vault.test.ts` covers deposit/redeem logic with mocked Privy + viem.

### ~~4. Bet settlement integration~~ DONE
`resolveBet.test.ts` covers payout computation, mock resolution, settlement.

### ~~5. Withdrawal reversal~~ DONE
`ledger.test.ts` covers reserve/reverse pattern, idempotency keys.

---

## P2 — ~~Beta gaps~~ DONE

### ~~6. Integration tests on API routes~~ DONE
Added `vault.test.ts`, `resolveBet.test.ts`, `ledger.test.ts` (113 total tests).

### ~~7. `earn.ts` LI.FI Earn wrapper~~ DONE
Dynamic vault discovery via `bestUsdcVaultOnBase()`. Per-group vaults from DB.

---

## P3 — ~~Polish~~ DONE

### ~~8. Demo mode~~ DONE
Search + trending routes prepend mock markets when `NEXT_PUBLIC_BETPAL_DEMO_MODE=true`.

### ~~9. Rename `safe_address` column~~ DONE
Renamed to `wallet_address` across codebase + idempotent migration in `schema.sql`.

---

## DB Setup

See [`supabase/README.md`](supabase/README.md) for full instructions.

```bash
psql "$DATABASE_URL" -f supabase/schema.sql
```

Or paste into the Supabase dashboard SQL editor.
