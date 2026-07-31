-- ============================================================
-- SteelEagle — Canonical Schema (Neon Postgres)
-- Filename is historical (pre-Neon migration); this file is the
-- committed source of truth for the live Neon database.
-- ============================================================

-- --------------------------------------------------------
-- tokens: stores Schwab OAuth access + refresh tokens
-- Single-user app — only one row ever lives here (upserted)
-- --------------------------------------------------------
create table if not exists tokens (
  id           integer primary key default 1,  -- always row 1
  access_token              text        not null,
  refresh_token             text        not null,
  access_token_expires_at   timestamptz not null,
  refresh_token_expires_at  timestamptz not null,
  created_at                timestamptz default now(),
  updated_at                timestamptz default now()
);

-- Prevent accidental second rows
create unique index if not exists tokens_single_row on tokens ((true));

-- --------------------------------------------------------
-- accounts: cached Schwab hashed account number
-- Populated automatically after first OAuth login
-- --------------------------------------------------------
create table if not exists accounts (
  id             integer primary key default 1,  -- always row 1
  account_hash   text        not null,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

create unique index if not exists accounts_single_row on accounts ((true));

-- --------------------------------------------------------
-- iv_history: daily ATM IV snapshots for SPY, TLT, GLD
-- Used to calculate IV Rank (current IV vs 52-week range)
-- Populated by the daily cron job at 4:15 PM ET
-- --------------------------------------------------------
create table if not exists iv_history (
  id                uuid        primary key default gen_random_uuid(),
  symbol            text        not null,
  snapshot_date     date        not null,
  -- PERCENTAGE, e.g. 14.5 = 14.5% — Schwab's `volatility` field is already a
  -- percentage (a known doc trap; see CLAUDE.md). The original comment here
  -- said "decimal, e.g. 0.18 = 18%" and was wrong: live rows read 3.99, 60.6,
  -- 141.1. Corrected 2026-07-31.
  atm_iv            numeric     not null,
  underlying_price  numeric     not null,
  -- v2.6 (2026-07-31) — HOW this row was measured. Rows on different bases must
  -- never share an IV Rank min/max window; calculateIVRank reads only
  -- IV_BASIS_CURRENT. See lib/strategy/iv-basis.ts and
  -- migrations/2026-07-31-iv-basis.sql.
  --   'legacy_front_expiry' — pre-2026-07-31: nearest expiration, first strike,
  --                           no delta selection, no index root filter. Kept as
  --                           the forensic record; never used for IV Rank.
  --   'atm_28_52dte'        — ATM call (delta ~0.50) 28–52 DTE, root-filtered.
  --                           Identical by construction to the scanner's
  --                           currentIv (both call getOptionChain).
  iv_basis          text        not null default 'legacy_front_expiry',
  created_at        timestamptz default now(),

  -- One snapshot per symbol per day
  unique(symbol, snapshot_date)
);

create index if not exists iv_history_symbol_date on iv_history (symbol, snapshot_date desc);
create index if not exists iv_history_symbol_basis_date
  on iv_history (symbol, iv_basis, snapshot_date desc);

-- --------------------------------------------------------
-- user_settings: singleton row of operator preferences.
-- (Applied directly in Neon at v1.2; folded into this file
-- 2026-07-28 with the pause_exit_placement migration.)
--   tickers               — dashboard scanner cells (max 10 app-side)
--   pause_exit_placement  — when true, the 4:15 exit sweep skips
--                           GTC placement (step c) ONLY. Reconcile
--                           and 21-DTE alerts always run; standing
--                           GTCs at Schwab are unaffected.
-- --------------------------------------------------------
create table if not exists user_settings (
  id                    integer     primary key default 1,  -- always row 1
  tickers               text[]      not null default '{SPY,TLT,GLD}',
  pause_exit_placement  boolean     not null default false,
  updated_at            timestamptz not null default now()
);

create unique index if not exists user_settings_single_row on user_settings ((true));

-- --------------------------------------------------------
-- trades: one row per logical iron condor, entry through final exit.
-- A roll is NOT a new trade — it mutates this row's running credit/debit
-- totals and current_expiration, with the leg-level detail captured in
-- trade_events. net_credit = total_credit_collected - total_debit_paid
-- (derived, never stored). See docs/steeleagle-session-8-addendum.md §A2.
-- --------------------------------------------------------
create table if not exists trades (
  id                      uuid          primary key default gen_random_uuid(),
  symbol                  text          not null,
  -- Narrowed to 'core' in v2.1.1 (earnings sleeve removed; zero historical
  -- earnings rows existed). Live-DB migration: see v2.1.1 removal summary.
  sleeve                  text          not null check (sleeve in ('core')),
  status                  text          not null default 'open'
                                          check (status in ('open', 'closed')),

  opened_at               timestamptz   not null,
  closed_at               timestamptz,

  -- Expiration tracking — current_expiration updates on each roll
  initial_expiration      date          not null,
  current_expiration      date          not null,

  -- Credit accounting — the source of truth for profit-target math
  initial_credit          numeric(10,2) not null,   -- credit collected at entry; never changes
  total_credit_collected  numeric(10,2) not null,   -- initial + all roll credits
  total_debit_paid        numeric(10,2) not null default 0, -- all closing/roll debits

  initial_bpr             numeric(10,2) not null,
  contracts               integer       not null default 1,

  close_reason            text          check (close_reason in (
                            'profit_target', 'stop_loss', '21_dte', 'manual', 'expired'
                          )),
  -- v2.2: Schwab order id of the standing GTC 50%-profit exit; null = no
  -- standing exit on record. Bookkeeping, not truth — the sweep verifies
  -- against fetched order state every run (spec §6.4). Cleared on close.
  exit_order_id           text,
  notes                   text,
  created_at              timestamptz   not null default now(),
  updated_at              timestamptz   not null default now()
);

create index if not exists trades_status_idx on trades (status);
create index if not exists trades_symbol_opened_idx on trades (symbol, opened_at desc);

-- --------------------------------------------------------
-- trade_events: append-only leg-level event log. Every entry, close, and
-- roll leg becomes one row. source/schwab_order_id are forward-compat for
-- v2.0 automated execution — no migration needed when fills auto-populate.
-- --------------------------------------------------------
create table if not exists trade_events (
  id              uuid          primary key default gen_random_uuid(),
  trade_id        uuid          not null references trades (id) on delete cascade,

  event_type      text          not null check (event_type in (
                    'open',         -- initial entry leg
                    'close',        -- final exit leg
                    'roll_close',   -- buying back a leg being replaced
                    'roll_open'     -- opening the replacement leg
                  )),
  leg             text          not null check (leg in (
                    'long_put', 'short_put', 'short_call', 'long_call'
                  )),

  strike          numeric(10,2) not null,
  expiration      date          not null,
  delta           numeric(6,4),                     -- signed; puts negative, calls positive
  contracts       integer       not null default 1,
  price           numeric(10,4) not null,           -- fill price per share
  credit_debit    text          not null check (credit_debit in ('credit', 'debit')),
  amount          numeric(10,2) not null,           -- price × 100 × contracts, always positive; sign from credit_debit

  -- Forward-compat for v2.0 automated execution
  source          text          not null default 'manual'
                                  check (source in ('manual', 'schwab_fill')),
  schwab_order_id text,                             -- null until v2.0; links to Schwab fill record

  occurred_at     timestamptz   not null,
  notes           text,
  created_at      timestamptz   not null default now()
);

create index if not exists trade_events_trade_id_idx on trade_events (trade_id, occurred_at);
