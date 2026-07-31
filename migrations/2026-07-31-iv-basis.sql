-- ============================================================
-- Migration: IV measurement basis (2026-07-31) — v2.6
--
-- WHY: IV Rank compared today's IV (scanner: ATM call, delta ~0.50,
-- 28-52 DTE) against a 52-week range built by the cron from the
-- NEAREST expiration's first strike (often 0-2 DTE, no delta
-- selection, no index root filter). Two different measurements on
-- the two sides of one formula.
--
-- Near-expiry ATM IV is numerically unstable, so the stored series
-- carried both tails: 30 zero rows across SPY/QQQ/IWM/SLV/DIA/GLD/
-- AAPL/TLT (dragging low52w to 0, inflating ranks) and implausible
-- highs (SPY 60.6%, QQQ 141.1%) which suppressed them. Suppression
-- dominated.
--
-- Rows on the old and new bases must never share a min/max window,
-- so each row records how it was measured and calculateIVRank reads
-- only the current basis. Legacy rows are RETAINED, not deleted --
-- they are the forensic record, and cost nothing once filtered.
--
-- CONSEQUENCE (accepted by the operator 2026-07-31): every symbol
-- reverts to CALIBRATING until it has 20 trading days on the new
-- basis (~4 weeks). There is no backfill -- Schwab's /chains serves
-- no historical IV. The v2.5 override on all verdicts is what makes
-- this survivable: every card stays placeable throughout.
--
-- APPLY THIS IN NEON BEFORE DEPLOYING THE CODE -- calculateIVRank's
-- SELECT gains the column (repo rule: migration first when a SELECT
-- gains a column).
--
-- Backfilling existing rows to 'legacy_front_expiry' is what the
-- DEFAULT does: every pre-existing row was written by the old path.
-- ============================================================

ALTER TABLE iv_history
  ADD COLUMN iv_basis text NOT NULL DEFAULT 'legacy_front_expiry';

-- The IV Rank query filters symbol + basis and orders by date. The existing
-- (symbol, snapshot_date desc) index no longer covers the basis predicate.
CREATE INDEX IF NOT EXISTS iv_history_symbol_basis_date
  ON iv_history (symbol, iv_basis, snapshot_date DESC);
