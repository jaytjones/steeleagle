# Session 8 Addendum — Post-Session Design Notes

**Date:** June 6, 2026 (same day, post-build discussion)
**Scope:** Not built this session — design decisions captured for next-session scoping.
**Topics:** Trade journal sequencing rationale; roll-aware journal data model.

---

## A1. Is the Trade Journal the Next Logical Step?

**Yes.** It's the prerequisite that unblocks the rest of the automation roadmap, not just a nice-to-have retrospective feature.

### What's currently broken without it

- **50%-profit exit tracking is impossible.** Schwab's position endpoint returns current marks but not what was originally collected. `openCredit` doesn't exist anywhere in the current data model. Without it, neither a manual alert nor an automated exit cron can compute the profit target.
- **Crisis enforcement is permanently best-effort.** `detectCoreStop` (shipped S8) can only see *currently open* positions at or past their stop. The strategy rule (§8.4) is "core stop *happened this week*" — a closed-trade event. There is nowhere to query that. The manual toggle is the only full-crisis signal available, and it requires the operator to remember to flip it.
- **Roll workflow has no home.** The strategy's adjustment mechanic (§5 — roll untested side when short delta drifts to ~30Δ) requires a concept of a trade lifecycle with multiple events attached to one logical position. The current data model has no such concept.
- **Automated exit cron (pre-v2.0) has nowhere to write.** When the cron fires a closing order, it needs to record `close_reason`, update trade status, and log the fill. Without a journal table, the cron has no write target.

### Sequencing vs. the one competing candidate

The only realistic alternative next milestone is the **earnings liquidity filter** (spread-vs-credit check on post-earnings weeklies). That's a genuine gap and is small (~1 hour). But it doesn't unblock anything downstream. The journal unblocks crisis enforcement, profit-target exits, roll tracking, and the automated execution path — all at once. Do the liquidity filter opportunistically as a warmup or alongside, not instead.

**Confirmed build order:** trade journal → automated exits (exit cron) → trade placement (v2.0 execution).

---

## A2. Roll-Aware Trade Journal — Data Model Design

### Core design principle

**A roll is not a new trade. It is a mutation of an existing position.**

The wrong model: one journal row per roll, each with its own credit figure. That makes cumulative P&L and profit-target computation require summing across rows with no guaranteed linkage. The right model: one logical trade record (the full lifecycle) with an append-only event log for every leg-level action.

### Two-table schema

#### `trades` — one row per logical iron condor, entry through final exit

```sql
create table if not exists trades (
  id                      uuid          primary key default gen_random_uuid(),
  symbol                  text          not null,
  sleeve                  text          not null check (sleeve in ('core', 'earnings')),
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
  -- net_credit = total_credit_collected - total_debit_paid (derive, don't store)

  initial_bpr             numeric(10,2) not null,
  contracts               integer       not null default 1,

  close_reason            text          check (close_reason in (
                            'profit_target', 'stop_loss', '21_dte', 'manual', 'expired'
                          )),
  notes                   text,
  created_at              timestamptz   not null default now(),
  updated_at              timestamptz   not null default now()
);

create index if not exists trades_status_idx on trades (status);
create index if not exists trades_symbol_opened_idx on trades (symbol, opened_at desc);
```

#### `trade_events` — append-only leg-level event log

```sql
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
  price           numeric(10,4) not null,            -- fill price per share
  credit_debit    text          not null check (credit_debit in ('credit', 'debit')),
  amount          numeric(10,2) not null,            -- price × 100 × contracts, always positive; sign from credit_debit

  -- Forward-compat for v2.0 automated execution
  source          text          not null default 'manual'
                                  check (source in ('manual', 'schwab_fill')),
  schwab_order_id text,                              -- null until v2.0; links to Schwab fill record

  occurred_at     timestamptz   not null,
  notes           text,
  created_at      timestamptz   not null default now()
);

create index if not exists trade_events_trade_id_idx on trade_events (trade_id, occurred_at);
```

### How a roll maps to these tables

Scenario: short put side is tested (drifts to ~30Δ); operator rolls the untested call side from 16Δ to 30Δ per §5.

```
trade_events rows written for the roll:

  roll_close | short_call | old_strike | debit   | amount = cost to buy back
  roll_close | long_call  | old_strike | credit  | amount = received selling the long
  roll_open  | short_call | new_strike | credit  | amount = new premium collected
  roll_open  | long_call  | new_strike | debit   | amount = cost of new long

trades row updated:

  total_credit_collected += (roll_open credits)
  total_debit_paid       += (roll_close debits + roll_open debits)
  current_expiration      = new expiration (if rolled out in time)
  updated_at              = now()
```

Net credit at any point: `total_credit_collected - total_debit_paid`. Profit target: `net_credit × 0.50`. This is always computable regardless of how many rolls have occurred.

### What this unlocks immediately

- **Profit target** — `net_credit` is always current; current mark value from Schwab position endpoint gives the other side of the comparison.
- **Exact crisis detection** — `select 1 from trades where close_reason = 'stop_loss' and closed_at > now() - interval '7 days'` replaces the open-stop proxy in `detectCoreStop`.
- **Position-alerts accuracy** — roll events update `current_expiration` and the rolled strikes on the `trades` row; alerts can reflect the actual current risk, not the original strikes.
- **Post-mortem** — every roll, every leg, every fill price is queryable. `notes` column on both tables supports qualitative capture.
- **Automated exit cron (pre-v2.0)** — writes `trade_events` of type `close` and sets `trades.close_reason` + `closed_at`. No schema change needed when the cron replaces the human.

### One forward-compat decision to make now

The `source` + `schwab_order_id` columns on `trade_events` exist precisely so v2.0 (automated execution) can write fills into the same table without a migration. When a Schwab fill arrives, `source = 'schwab_fill'` and `schwab_order_id` links to the order. Manual entries remain `source = 'manual'` with `schwab_order_id = null`. Reconciliation between manual and auto entries is unambiguous.

### What the entry form looks like (v1.5 manual-entry phase)

The scanner already produces a fully-specified 4-leg condor. The journal entry form for a new trade should pre-populate from the scanner card — symbol, strikes, deltas, expiration, credit, BPR — requiring the operator only to confirm and optionally add notes. The form writes one `trades` row and four `trade_events` rows (one per leg, all `event_type = 'open'`). A roll entry form adds four more `trade_events` rows and patches the `trades` totals. No new trade row is created for a roll.

---

## A3. Revised Horizon / Build Order

Updated to reflect these decisions. Replaces the "On the Horizon" section of the S8 summary.

| Order | Milestone | Unlocks |
| :--- | :--- | :--- |
| **1** | Trade journal (v1.5) | Crisis enforcement, profit-target exits, roll tracking, post-mortem |
| **2** | Automated exit cron | 50%-profit + 21-DTE close without manual intervention |
| **3** | Trade placement (v2.0) | One-tap entry from scanner card; fills auto-populate journal |
| — | Earnings liquidity filter | Small; do alongside journal or as a warmup |
| — | Holiday calendar in entry-window | Minor correctness gap; low urgency |
| — | Backlog (PRD §10) | Custom domain, security hardening, mobile PWA |

---

**End of Session 8 Addendum**
