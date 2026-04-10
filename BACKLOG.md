# BetPal — End-to-End Testing Backlog

Ordered by what blocks a working demo first.

---

## 🔴 P0 — Must have before any E2E path works

### 1. Environment variables (13 vars)
`betpal/.env.example` → copy to `.env.local` and populate all:

| Variable | Source |
|---|---|
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy dashboard → App ID |
| `PRIVY_APP_SECRET` | Privy dashboard → App secret |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase project → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase project → Settings → API |
| `LIFI_API_KEY` | LI.FI developer portal |
| `LIFI_INTEGRATOR` | `betpal` (already set) |
| `APP_RESOLVER_PRIVATE_KEY` | `node -e "console.log(require('viem').generatePrivateKey())"` |
| `APP_RESOLVER_ADDRESS` | Derive from the key above |
| `BASE_RPC_URL` | `https://mainnet.base.org` (already set) or Alchemy/Infura |
| `MORPHO_USDC_VAULT_BASE` | Discover via LI.FI Earn API (see `src/lib/earn.ts`) |
| `NEXT_PUBLIC_BETPAL_DEMO_MODE` | `false` for real; `true` for offline UI |
| `CRON_SECRET` | Any random string, e.g. `openssl rand -hex 32` |

### 2. Database schema not applied
`supabase/schema.sql` must be applied to a live Supabase project. No migration tooling exists yet.
See **DB Setup** section below for the one-command path.

### 3. Cron not scheduled
`/api/cron/resolve-bets` exists but there is no `vercel.json` cron config.
The endpoint must be manually triggered (or a `vercel.json` added) — see P1 below.

---

## 🟠 P1 — Required for the happy path to complete

### 4. Phase 3 deposit confirmation (riskiest untested path)
`/api/groups/[id]/deposits/[depositId]/confirm` advances the deposit state machine to Phase 3.
No integration test exists. A failed confirm leaves a transaction stuck in `executing` with no
retry or rollback path.

### 5. Bet settlement sequence (riskiest untested path)
`src/lib/resolveBet.ts` → `src/app/api/cron/resolve-bets` → ledger payouts.
No integration test exists. A mis-ordered payout or idempotency key collision silently corrupts
the ledger.

### 6. Withdrawal expiry reversal (riskiest untested path)
If a withdrawal Safe tx is never signed, the funds must be unlocked. The reversal path has no test
and no automated trigger.

### 7. Safe lazy deploy
`src/lib/safe.ts` deploys the Safe counterfactually — it only materialises on-chain after the
**first Phase 3 deposit**. Any test that calls Safe operations before that deposit will fail or
operate on a non-existent contract.

### 8. Withdrawal is manual
`src/app/groups/[id]/WithdrawForm.tsx` generates a Gnosis Safe deeplink but the user must open the
Safe app and sign manually. There is no automated Safe tx execution path.

---

## 🟡 P2 — Gaps that will surface during beta

### 9. Zero integration tests on API routes
No test file covers:
- 3-phase deposit state machine (`/api/groups/[id]/deposits/**`)
- Bet settlement (`/api/bets/[id]/resolve`)
- Cron worker (`/api/cron/resolve-bets`)

Only unit tests exist (`amounts.test.ts`, `payouts.test.ts`, `polymarket.test.ts`, `safe.test.ts`).

### 10. Post-deposit member invites broken
`group_members` freezes after the first deposit (by design for Safe threshold stability).
The owner-add re-invite flow (add new signer to Safe, re-invite member) is not wired in the UI or API.

### 11. Member list not rendered
`/api/groups/[id]/balance` returns members. `GroupDashboard.tsx` does not render the member list.

### 12. `earn.ts` is a stub
`src/lib/earn.ts` wraps the LI.FI Earn API but is not fully implemented.
`MORPHO_USDC_VAULT_BASE` must be hardcoded once discovered; the dynamic-discovery path is incomplete.

---

## ⚪ P3 — Nice-to-haves / polish

### 13. Demo mode incomplete
`NEXT_PUBLIC_BETPAL_DEMO_MODE=true` flag exists in `src/lib/publicEnv.ts` but the fake on-chain
path is not fully wired. Useful for offline UI demos without real wallets.

### 14. Add `vercel.json` cron config
```json
{
  "crons": [{
    "path": "/api/cron/resolve-bets",
    "schedule": "0 * * * *"
  }]
}
```
Without this, resolution never runs automatically on Vercel.

---

## DB Setup

See [`supabase/README.md`](supabase/README.md) (created alongside this file) for full instructions.
Quick path once you have a Supabase project:

```bash
# One-time: install CLI
brew install supabase/tap/supabase

# Apply schema
psql "$DATABASE_URL" -f supabase/schema.sql
```

Or paste `supabase/schema.sql` directly into the Supabase dashboard SQL editor.
