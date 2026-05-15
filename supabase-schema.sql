-- ============================================================
-- SteelEagle — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query
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
  atm_iv            numeric     not null,  -- decimal, e.g. 0.18 = 18%
  underlying_price  numeric     not null,
  created_at        timestamptz default now(),

  -- One snapshot per symbol per day
  unique(symbol, snapshot_date)
);

create index if not exists iv_history_symbol_date on iv_history (symbol, snapshot_date desc);
