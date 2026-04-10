# Database Setup

## Prerequisites

You need a Supabase project. Create one at https://supabase.com — free tier is fine.

Once created, grab these three values from **Project Settings → API**:
- Project URL → `NEXT_PUBLIC_SUPABASE_URL`
- `anon` public key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `service_role` secret key → `SUPABASE_SERVICE_ROLE_KEY`

Paste them into `betpal/.env.local`.

---

## Option A — SQL Editor (fastest, no CLI needed)

1. Open your Supabase project → **SQL Editor**
2. Click **New query**
3. Paste the contents of `supabase/schema.sql`
4. Click **Run**

Done. The schema is idempotent (`CREATE … IF NOT EXISTS`) so re-running is safe.

---

## Option B — psql from your terminal

Get your **direct connection string** from Supabase → Project Settings → Database → Connection string (URI mode, not pooler).

```bash
psql "postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT-REF].supabase.co:5432/postgres" \
  -f supabase/schema.sql
```

---

## Option C — Supabase CLI (local dev / CI)

```bash
# Install CLI (macOS)
brew install supabase/tap/supabase

# Link to your project (one-time)
cd betpal
supabase login
supabase link --project-ref YOUR_PROJECT_REF

# Push the schema
supabase db push --db-url "$(grep NEXT_PUBLIC_SUPABASE_URL .env.local | cut -d= -f2)"
```

Or, to run a full local stack (no network needed):

```bash
supabase start          # starts Postgres + Studio on localhost
supabase db reset       # applies schema.sql + any seeds
```

The local Studio runs at http://localhost:54323.

---

## Verify

Run this in the SQL Editor or psql to confirm all tables exist:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
order by table_name;
```

Expected output:

```
 balance_events
 bets
 friendships
 group_members
 groups
 invite_links
 polymarket_markets_cache
 stakes
 transactions
 users
```

---

## Required extensions

The schema enables these automatically:

| Extension | Purpose |
|---|---|
| `uuid-ossp` | `uuid_generate_v4()` primary keys |
| `pg_trgm` | Trigram indexes for name/ENS search |
| `citext` | Case-insensitive wallet address columns |

All three are available on Supabase free tier. If `pg_trgm` is missing, enable it via
**Database → Extensions** in the Supabase dashboard.
