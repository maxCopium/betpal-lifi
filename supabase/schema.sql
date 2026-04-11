-- BetPal — full Supabase schema (Day 1 deployment).
-- Designed once, deployed once. No mid-build migrations.
--
-- Conventions:
--   * All money is integer cents (USD-equivalent), never floats.
--   * `balance_events` is append-only and is the source of truth for ledger UX.
--   * On-chain vault balance reconciles against the ledger hourly.
--   * Idempotency keys gate every external-side-effect insert.
--   * `lower(wallet_address)` is the canonical key for any wallet lookup.

create extension if not exists "uuid-ossp";
create extension if not exists "pg_trgm";
create extension if not exists "citext";

-- =============================================================================
-- USERS
-- =============================================================================
create table if not exists users (
  id              uuid primary key default uuid_generate_v4(),
  privy_id        text not null unique,
  wallet_address  citext not null unique,
  display_name    text,
  ens_name        text,
  basename        text,
  avatar_url      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists users_display_name_trgm
  on users using gin (display_name gin_trgm_ops);
create index if not exists users_ens_trgm
  on users using gin (ens_name gin_trgm_ops);
create index if not exists users_basename_trgm
  on users using gin (basename gin_trgm_ops);

-- =============================================================================
-- GROUPS
-- =============================================================================
create table if not exists groups (
  id               uuid primary key default uuid_generate_v4(),
  name             text not null,
  safe_address     citext,                  -- group custodial wallet address (legacy column name)
  vault_address    citext not null,         -- Morpho USDC on Base for v1
  vault_chain_id   integer not null default 8453,
  threshold        integer not null check (threshold >= 2),
  status           text not null default 'pending'
                     check (status in ('pending','active','frozen','closed')),
  created_by       uuid not null references users(id),
  created_at       timestamptz not null default now()
);

create index if not exists groups_status_idx on groups(status);

-- =============================================================================
-- GROUP_MEMBERS  (many-to-many)
-- =============================================================================
create table if not exists group_members (
  group_id   uuid not null references groups(id) on delete cascade,
  user_id    uuid not null references users(id),
  role       text not null default 'member'
               check (role in ('owner','member')),
  joined_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index if not exists group_members_user_idx on group_members(user_id);

-- =============================================================================
-- FRIENDSHIPS
-- =============================================================================
create table if not exists friendships (
  user_id    uuid not null references users(id),
  friend_id  uuid not null references users(id),
  source     text not null
               check (source in ('search','invite','recent','address','manual')),
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);

-- =============================================================================
-- BETS
-- =============================================================================
create table if not exists bets (
  id                    uuid primary key default uuid_generate_v4(),
  group_id              uuid not null references groups(id),
  creator_id            uuid not null references users(id),
  polymarket_market_id  text not null,
  polymarket_url        text not null,
  title                 text not null,
  options               jsonb not null,    -- e.g. ["YES","NO"]
  join_deadline         timestamptz not null,
  max_resolution_date   timestamptz not null,
  status                text not null default 'open'
                          check (status in ('open','locked','resolving','settled','voided')),
  resolution_outcome    text,
  resolution_evidence   jsonb,
  settled_at            timestamptz,
  processing_started_at timestamptz,       -- worker advisory lock fallback
  created_at            timestamptz not null default now()
);

create index if not exists bets_group_status_idx on bets(group_id, status);
create index if not exists bets_status_idx on bets(status);
create index if not exists bets_max_resolution_idx on bets(max_resolution_date)
  where status in ('open','locked','resolving');

-- =============================================================================
-- STAKES (one row per user per bet)
-- =============================================================================
create table if not exists stakes (
  id              uuid primary key default uuid_generate_v4(),
  bet_id          uuid not null references bets(id),
  user_id         uuid not null references users(id),
  outcome_chosen  text not null,
  amount_cents    bigint not null check (amount_cents > 0),
  created_at      timestamptz not null default now(),
  unique (bet_id, user_id)
);

create index if not exists stakes_bet_idx on stakes(bet_id);
create index if not exists stakes_user_idx on stakes(user_id);

-- =============================================================================
-- BALANCE_EVENTS  (append-only ledger)
-- =============================================================================
create table if not exists balance_events (
  id              uuid primary key default uuid_generate_v4(),
  group_id        uuid not null references groups(id),
  user_id         uuid not null references users(id),
  delta_cents     bigint not null,           -- signed
  reason          text not null
                    check (reason in
                      ('deposit','stake_lock','stake_refund','payout',
                       'yield_credit','reconciliation','adjustment')),
  bet_id          uuid references bets(id),
  tx_hash         text,
  idempotency_key text not null unique,
  created_at      timestamptz not null default now()
);

create index if not exists balance_events_group_user_idx
  on balance_events(group_id, user_id, created_at);
create index if not exists balance_events_bet_idx on balance_events(bet_id);

-- =============================================================================
-- TRANSACTIONS  (Composer operations, two-phase tracked)
-- =============================================================================
create table if not exists transactions (
  id                  uuid primary key default uuid_generate_v4(),
  group_id            uuid references groups(id),
  user_id             uuid references users(id),
  type                text not null
                        check (type in ('deposit','payout','withdrawal','rebalance')),
  amount_cents        bigint,
  actual_amount_cents bigint,                -- post-execution truth
  source_chain        integer,
  source_token        citext,
  dest_chain          integer,
  dest_token          citext,
  composer_route_id   text,
  tx_hash             text,
  status              text not null default 'pending'
                        check (status in
                          ('pending','executing','completed','failed','reverted','expired')),
  error_message       text,
  intended_bet_id     uuid references bets(id),
  intended_outcome    text,
  idempotency_key     text not null unique,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists transactions_group_idx on transactions(group_id);
create index if not exists transactions_status_idx on transactions(status);

-- =============================================================================
-- POLYMARKET MARKETS CACHE
-- =============================================================================
create table if not exists polymarket_markets_cache (
  market_id           text primary key,
  payload_json        jsonb not null,
  resolution_status   text,
  resolution_outcome  text,
  last_synced         timestamptz not null default now()
);

-- =============================================================================
-- INVITE LINKS
-- =============================================================================
create table if not exists invite_links (
  token       text primary key,
  group_id    uuid not null references groups(id),
  inviter_id  uuid not null references users(id),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_by     uuid references users(id),
  created_at  timestamptz not null default now()
);

create index if not exists invite_links_group_idx on invite_links(group_id);

-- =============================================================================
-- MIGRATIONS (idempotent additions)
-- =============================================================================

-- Mock market resolution for demo purposes.
alter table bets add column if not exists mock_resolved_outcome text;

-- Human-readable question for the bet (duplicated from polymarket for mock bets).
alter table bets add column if not exists question text;

-- =============================================================================
-- CANCEL_VOTES (unanimous bet cancellation)
-- =============================================================================
create table if not exists cancel_votes (
  bet_id      uuid not null references bets(id),
  user_id     uuid not null references users(id),
  created_at  timestamptz not null default now(),
  primary key (bet_id, user_id)
);
