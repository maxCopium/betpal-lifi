# BetPal

Bet with friends on Polymarket outcomes. Pooled stakes earn yield in a shared
group vault on Base until resolution. Zero house edge.

Built for the **DeFi Mullet Hackathon #1** — LI.FI's Earn API + Composer.

> Polymarket is the **oracle**, not the venue. We never trade on it; we only
> read resolution. Stakes live in a shared Morpho USDC vault on Base, brought
> in (and taken out) cross-chain via LI.FI Composer in a single signature.

---

## How it works

1. **Sign in** — Privy embedded wallet (email or Google).
2. **Create a group** — pick friends by name / ENS / basename / 0x. The app
   computes a counterfactual Safe address (M-of-N+1, where the +1 is BetPal's
   resolver key that can never reach threshold alone).
3. **Deposit** — pick any chain + token. LI.FI Composer routes your funds in
   one signature into a Morpho USDC vault on Base, owned by the group's Safe.
4. **Bet** — search Polymarket via the Gamma API, anchor a bet to a market id,
   set a join deadline. Other members place stakes from their group balance.
5. **Resolve** — once Polymarket settles, click *Try to resolve*. The app
   reads the winning outcome from Polymarket, runs the pari-mutuel payout
   calculation (integer cents, deterministic dust handling), and credits
   winners' ledger balances. Refunds for void / no-winners / single-outcome
   are handled automatically.
6. **Withdraw** — get a Composer quote to unwind your share of the vault to
   any chain + token. Submit the on-chain Safe transaction via the Safe Web
   App.

---

## Architecture at a glance

```
┌─────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Next.js 16     │    │  LI.FI Composer  │    │  Morpho USDC     │
│  (Win98 UI)     │───▶│  /quote          │───▶│  vault on Base   │
└─────────────────┘    └──────────────────┘    └──────────────────┘
        │                                              ▲
        │                                              │ owned by
        ▼                                              │
┌─────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Supabase       │    │  Polymarket      │    │  Group Safe      │
│  Postgres       │◀───│  Gamma API       │    │  (M-of-N+1)      │
│  (ledger,       │    │  (oracle only)   │    │                  │
│  groups, bets)  │    └──────────────────┘    └──────────────────┘
└─────────────────┘
```

- **Off-chain ledger** is append-only `balance_events` (signed deltas, every
  row idempotent on `idempotency_key`). Source of truth is on-chain; the
  ledger is the fast UX projection. `/api/groups/[id]/reconcile` reads the
  vault's `convertToAssets(balanceOf(safe))` and reports drift.
- **Pari-mutuel payouts** in `src/lib/payouts.ts` — pure, integer cents,
  largest-remainder dust handling, deterministic tie-breaks. 36 unit tests.
- **Safe never moves alone** — `src/lib/safe.ts` enforces threshold ≥ 2 and
  asserts the resolver key alone can never meet threshold, both in build and
  on-chain post-deploy.

---

## Local setup

### Prerequisites

- Node 20+
- A Supabase project (free tier is fine)
- A Privy app id + secret
- A LI.FI API key (https://li.fi/)
- A Morpho USDC vault address on Base (discovered via LI.FI Earn API)
- An app resolver EOA (private key — see `.env.example`)

### Steps

```bash
# 1. Install
cd betpal
npm install

# 2. Apply the schema to your Supabase project
# (paste supabase/schema.sql into the SQL editor or use psql)

# 3. Configure env
cp .env.example .env.local
# Fill in every variable in .env.local

# 4. Type-check + tests + build
npx tsc --noEmit
npx vitest run
npx next build

# 5. Dev server
npx next dev
```

Open http://localhost:3000.

---

## Environment variables

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_PRIVY_APP_ID` | From the Privy dashboard |
| `PRIVY_APP_SECRET` | Server-only |
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | From Supabase project settings |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only — used for the ledger |
| `LIFI_API_KEY` | https://li.fi |
| `LIFI_INTEGRATOR` | Free-form integrator id, defaults to `betpal` |
| `APP_RESOLVER_PRIVATE_KEY` / `_ADDRESS` | The +1 signer on every group Safe — never alone, threshold is always ≥ 2 |
| `BASE_RPC_URL` | Defaults to `https://mainnet.base.org` |
| `MORPHO_USDC_VAULT_BASE` | Discover via LI.FI Earn API; pin the chosen vault here |

---

## Project layout

```
src/
  app/
    api/
      groups/                       group CRUD + bets, deposits, withdrawals,
                                    invites, balance, reconcile
      bets/[id]/                    bet detail, stake, resolve
      polymarket/search/            server-proxied Gamma search
      friends/search/               trigram fuzzy user search
      invites/[token]/accept/       invite redemption
    groups/                         /groups/new + /groups/[id] dashboard
    bets/[id]/                      bet detail page
    invite/[token]/                 invite acceptance page
  components/win98/                 Win98 chrome (Window, Desktop, Taskbar,
                                    CopyProgressDialog)
  lib/
    auth.ts                         Privy server-auth + user upsert
    composer.ts                     LI.FI Composer wrapper
    earn.ts                         LI.FI Earn API wrapper
    polymarket.ts                   Polymarket Gamma wrapper + settleability
    payouts.ts                      Pari-mutuel calculation (pure, tested)
    ledger.ts                       Append-only balance events
    safe.ts                         Counterfactual Safe + invariants
    supabase.ts                     Service-role client
    viem.ts                         Base public client
    env.ts / publicEnv.ts           Server / client env split
supabase/schema.sql                 Full Postgres schema (10 tables)
```

---

## Hard rules

These are enforced in code, not just documented:

- **Safe threshold is always ≥ 2.** `src/lib/safe.ts` rejects M=1 and asserts
  the app key alone can never reach threshold.
- **Money is integer cents.** No floats anywhere in `payouts.ts`. The sum of
  payouts is exact and equals the total pool.
- **Ledger is append-only.** Every state change is a new `balance_events`
  row with a signed delta and an idempotency key. No UPDATEs, no DELETEs.
- **Polymarket is the oracle, not the venue.** We pay out only when the
  market is `closed`, past a 2-hour dispute buffer, with a winning outcome
  price ≥ 0.99. Otherwise the bet stays in `resolving` state.
- **Membership freezes on first deposit.** Counterfactual Safe addresses
  depend on the owner set, so we re-predict the address as members accept
  invites — until the first successful deposit, after which the group flips
  to `active` and invites are blocked.

---

## Tests

```bash
npx vitest run
```

`src/lib/payouts.test.ts` — 36 tests covering:
- 1v1 splits
- multi-bettor pari-mutuel
- void / single staker / single outcome / no winners refunds
- dust handling (largest remainder, deterministic tie-breaks)
- input validation (negative pool, non-integer pool, zero stake, principal > pool, multi-outcome user)
- 100v100 scale test
