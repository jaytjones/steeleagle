-- ============================================================
-- Migration: v2.11 fill ledger (2026-08-14)
--
-- WHY: the strategy requires placing most trades outside the tool, so the
-- journal depends on the operator remembering to record them. A missed ENTRY
-- is caught later by Import and a missed CLOSE by Record Close, but a missed
-- ROLL had no fallback at all — deduplicateCandidates keys on
-- underlying+expiration, so a same-expiration roll is filtered as
-- alreadyImported and its changed strikes are never compared.
--
-- Proven live, twice, and expensively: the SPY 2026-09-11 and 2026-08-28 rolls
-- both went unjournaled, and GLD's exit GTC was REJECTED by Schwab EVERY NIGHT
-- from Aug 3 to Aug 13 2026 on strikes that had been rolled away twice. Nine
-- rejections. Every one recorded in sweep_runs and surfaced nowhere else.
--
-- These two tables make the account's own record durable so the app can derive
-- what the operator did rather than asking them to retype it.
--
-- ── Both tables are WRITE-ONLY from the cron and READ-ONLY everywhere else. ──
-- ── NOTHING IN THE PLACEMENT PATH MAY READ EITHER.                          ──
--
-- Same rule as sweep_runs, for the same reason: reconciliation FLAGS, it does
-- not BLOCK (April, 2026-08-04), and a HISTORY of flags is weaker evidence
-- than a live one. schwab_fills is a heuristic's input; it must never acquire
-- veto power over a live GTC.
--
-- ORDERING: no existing SELECT gains a column, so the strict
-- apply-before-deploy rule is relaxed here. Apply it in Neon anyway, before
-- deploying — the same courtesy sweep_runs got. Nothing is wired to the cron
-- until v2.11 step 6, so a missing table cannot currently affect a sweep.
-- ============================================================

-- --------------------------------------------------------
-- position_snapshots — the ANCHOR for April's accounting identity:
--
--     positions(T₀)  +  Σ order effects in (T₀, T₁]  ==  positions(T₁)
--
-- A zero residual is a COMPLETENESS PROOF, not a confidence score, and the
-- residual is exactly the class of events that produce no order at all —
-- expirations, assignments, exercises.
--
-- WHAT IS STORED, and why it is NOT the raw Schwab positions array:
--
-- `symbols` is the derived occSymbol → signed-net-quantity map from
-- positionsToQty(), which is the ENTIRE left side of the identity. The raw
-- array additionally carries per-leg P&L, market values and average prices —
-- none of which participate, all of which churn every snapshot, and which
-- inflate a daily row from ~1 KB to tens of KB.
--
-- This deviates from spec §5 ("raw Schwab positions array, accountNumber
-- stripped") deliberately. Storing only the derived map ELIMINATES the
-- identifier-leak risk rather than mitigating it: F4 established that
-- accountNumber is present on every raw order body, and a stripping step is a
-- thing that can be forgotten when a new field appears. A symbol→integer map
-- has nowhere for an account identifier to hide.
--
-- If forensics ever need the raw array, that is an additive migration.
-- --------------------------------------------------------
create table if not exists position_snapshots (
  id          uuid          primary key default gen_random_uuid(),

  -- The instant the positions were fetched. Set by the app, not the DB: this
  -- is the instant the snapshot DESCRIBES, and intervals are built from it.
  taken_at    timestamptz   not null,

  -- occSymbol → signed net contracts. Positive = long, negative = short.
  -- Net-zero legs are omitted, so "absent" and "zero" are the same state on
  -- both sides of a diff (see lib/journal/position-delta.ts).
  symbols     jsonb         not null,

  -- Denormalised for cheap sanity checks and for spotting a truncated fetch.
  symbol_count integer      not null default 0,

  created_at  timestamptz   not null default now()
);

-- The diff always wants "the most recent snapshot at or before T".
create index if not exists position_snapshots_taken_at_idx
  on position_snapshots (taken_at desc);

-- --------------------------------------------------------
-- schwab_fills — one row per Schwab order, keyed by ORDER ID.
--
-- The primary key is the point. "Have I journaled this fill?" becomes an exact
-- question with an exact answer, replacing the fuzzy underlying|expiration
-- match that Schwab's position aggregation has already broken once on GLD.
-- Positions are AGGREGATED; orders are NOT. Two 1-lot condors at identical
-- strikes are one position row but two distinct order ids.
--
-- Rows are ingested for ANY status, not just FILLED. A REJECTED order still
-- has a shape, and the GLD streak above is the strongest journal-drift signal
-- the account emits — Session 22 decided the inbox must surface rejected
-- placements, not only unjournaled fills.
--
-- `classification` holds the full FillClassification verbatim, for the same
-- reason sweep_runs.report is kept whole: a schema that must migrate to record
-- an incident is a schema that will not record the incident. It is built by
-- classifyFill(), which reads a fixed field list and therefore CANNOT carry
-- accountNumber (F4) — the containment is structural, not a stripping step.
--
-- The derived columns exist so the inbox query is an index hit rather than a
-- jsonb scan, exactly as sweep_runs' severity columns do.
-- --------------------------------------------------------
create table if not exists schwab_fills (
  -- Schwab's order id. TEXT, not bigint: every id in this codebase is carried
  -- as a string (trades.exit_order_id, ExitSweepReport) and a type split here
  -- would need casts at every join.
  order_id      text          primary key,

  entered_time  timestamptz   not null,   -- PLACEMENT time
  occurred_at   timestamptz   not null,   -- latest execution, else close, else entered

  status        text          not null,   -- raw Schwab status, uppercased
  shape         text          not null    -- classifyFill() result
                                check (shape in (
                                  'CONDOR_OPEN', 'CONDOR_CLOSE', 'ROLL',
                                  'PARTIAL_OPEN', 'PARTIAL_CLOSE',
                                  'NOT_OPTION', 'AMBIGUOUS'
                                )),

  -- Null when the legs span underlyings/expirations (a diagonal roll). Null is
  -- "cannot attribute", never a default — the classifier refuses to pick one.
  underlying    text,
  expiration    date,

  contracts     integer       not null default 0,
  filled        boolean       not null default false,

  -- The complete FillClassification, verbatim.
  classification jsonb        not null,

  -- Operator disposition. 'pending' is the inbox; the others are terminal.
  -- PRESERVED across re-ingestion — a later fetch may update the classification
  -- (status WORKING → FILLED) but must never silently un-dismiss something the
  -- operator has already judged.
  disposition   text          not null default 'pending'
                                check (disposition in ('pending', 'journaled', 'dismissed')),

  -- Set when the fill has been journaled into a trade. ON DELETE SET NULL: a
  -- deleted trade must not cascade away the account's own record of the fill.
  trade_id      uuid          references trades (id) on delete set null,

  ingested_at   timestamptz   not null default now(),
  updated_at    timestamptz   not null default now()
);

-- The inbox: pending rows, newest first.
create index if not exists schwab_fills_disposition_idx
  on schwab_fills (disposition, occurred_at desc);

-- Interval queries when rebuilding effects for a balance check.
create index if not exists schwab_fills_occurred_at_idx
  on schwab_fills (occurred_at desc);

-- Attribution lookups from a trade back to the fills that built it.
create index if not exists schwab_fills_trade_id_idx
  on schwab_fills (trade_id)
  where trade_id is not null;
