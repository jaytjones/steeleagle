-- ============================================================
-- SteelEagle v2.2 — migration + §6a manual-GTC adoption backfill
-- Run in the Neon SQL editor, top to bottom. July 24, 2026.
--
-- Order ids sourced from the live TOS working-orders view (Session 14).
-- The four standing GTC closes were placed manually and are adopted
-- into the journal so the sweep reconciles their fills as its own.
-- ============================================================

-- 1. Migration (spec §3)
ALTER TABLE trades ADD COLUMN exit_order_id text;

-- 2. Pre-backfill verification — expect EXACTLY these 4 rows.
--    If any row is missing or an expiration differs, STOP: the journal
--    and the TOS view disagree, and the mismatch must be resolved
--    before backfilling (a wrong association would reconcile a fill
--    onto the wrong trade).
SELECT id, symbol, current_expiration, status, contracts
FROM trades
WHERE status = 'open'
ORDER BY symbol, current_expiration;
-- Expected:
--   GLD  2026-08-21  open
--   SPY  2026-08-14  open
--   SPY  2026-08-21  open
--   TLT  2026-08-21  open

-- 3. Backfill (each statement must report UPDATE 1 — no more, no less)
UPDATE trades SET exit_order_id = '1007258139199'
  WHERE status = 'open' AND symbol = 'SPY' AND current_expiration = '2026-08-21';

UPDATE trades SET exit_order_id = '1007195162009'
  WHERE status = 'open' AND symbol = 'TLT' AND current_expiration = '2026-08-21';

UPDATE trades SET exit_order_id = '1007074485891'
  WHERE status = 'open' AND symbol = 'SPY' AND current_expiration = '2026-08-14';

UPDATE trades SET exit_order_id = '1007074485557'
  WHERE status = 'open' AND symbol = 'GLD' AND current_expiration = '2026-08-21';

-- 4. Post-backfill verification — all 4 open trades carry an id, no
--    open trade is left NULL, and no id is duplicated.
SELECT symbol, current_expiration, exit_order_id
FROM trades
WHERE status = 'open'
ORDER BY symbol, current_expiration;

SELECT exit_order_id, count(*)
FROM trades
WHERE exit_order_id IS NOT NULL
GROUP BY exit_order_id
HAVING count(*) > 1;  -- expect zero rows
