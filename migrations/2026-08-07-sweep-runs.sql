-- ============================================================
-- Migration: sweep run history (2026-08-07) — v2.9
--
-- WHY: between Aug 4 and Aug 6 2026 the post-close sweep detected a real
-- live-money fault on SPY 2026-09-11 — an unjournaled roll left the journal
-- at 725/740 while the account held 735/750 — and handled it exactly as
-- designed. Reconciliation raised a CRITICAL DRIFT. The placement path built
-- the GTC from the stale journal. Schwab REJECTED it ("may result in an
-- oversold/overbought position", orders 1007487397396 and 1007505458280).
-- The route's immediate-status confirm refused to store the id.
--
-- All of that happened three runs in a row and the operator saw none of it,
-- because ExitSweepReport is the HTTP response body of a cron invocation:
-- returned, console.log'd, and discarded. Detection worked; delivery did not.
-- There was no way to answer "what did the sweep do yesterday?" from the app.
--
-- This table is the audit record made durable. It is WRITE-ONLY from the cron
-- and READ-ONLY everywhere else. Nothing in the placement path may ever read
-- it — reconciliation FLAGS, it does not BLOCK (April, 2026-08-04), and the
-- same rule applies to its own history.
--
-- The full report is kept as jsonb rather than shredded into columns: it is a
-- forensic record whose shape has changed with almost every milestone
-- (v2.2 → v2.8.1), and a schema that must migrate to record an incident is a
-- schema that will not record the incident. The derived severity columns exist
-- so the banner's query stays an index hit instead of a jsonb scan.
--
-- No SELECT in existing code gains a column, so the ordering rule is relaxed
-- here — but apply it in Neon before deploying anyway: the cron writes on its
-- first run after deploy and a missing table would land in the sweep's
-- errors[] (isolated, non-fatal, but noise on a live-money run).
-- ============================================================

create table if not exists sweep_runs (
  id              uuid          primary key default gen_random_uuid(),

  -- When the sweep finished. Set by the app, not the DB: this is the instant
  -- the report describes, and it is compared against the cron schedule to
  -- detect a cron that has stopped firing (lib/strategy/sweep-report.ts).
  ran_at          timestamptz   not null,

  -- Derived by summarizeSweepRun(). Stored, not computed on read, so the
  -- banner query is a single indexed row fetch.
  severity        text          not null check (severity in ('critical', 'warning', 'ok')),
  critical_count  integer       not null default 0,
  warning_count   integer       not null default 0,
  headline        text          not null,

  -- The complete ExitSweepReport, verbatim.
  report          jsonb         not null,

  created_at      timestamptz   not null default now()
);

-- The banner reads exactly one row: the most recent. Everything else is
-- forensics, read by hand.
create index if not exists sweep_runs_ran_at_idx on sweep_runs (ran_at desc);
