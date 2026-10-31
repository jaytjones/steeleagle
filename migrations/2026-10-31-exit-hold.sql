-- ============================================================
-- SteelEagle v2.15 — per-trade GTC hold after an automatic roll
-- Run in the Neon SQL editor BEFORE the v2.15 code deploys: TRADE_SELECT
-- gains both columns, so the old code is unaffected and the new code fails
-- every journal read until they exist.
--
-- exit_hold_order_id — non-null = "the sweep journaled a roll on this trade
--   automatically from this Schwab order and JJ has not confirmed it; place
--   no GTC." Set by rollTrade in the SAME transaction as the roll events, so
--   the roll and its hold can never be separated. Cleared only by her click
--   (confirmAutoRollAction). The order id is the WHY — the chip, the flag and
--   the confirm card all name the fill.
-- exit_hold_at — when the hold was set. Drives the §8.3 escalation
--   (routine → critical after 3 unconfirmed scheduled runs), counted from the
--   clock, never from sweep_runs.
--
-- Both nullable with no default: every existing trade is un-held, which is
-- exactly today's behaviour. Additive only — nothing is backfilled.
-- ============================================================

ALTER TABLE trades ADD COLUMN exit_hold_order_id text;
ALTER TABLE trades ADD COLUMN exit_hold_at timestamptz;

-- Set together, cleared together. A hold with no time would escalate as
-- "age unknown" every night; a time with no hold is meaningless.
ALTER TABLE trades ADD CONSTRAINT trades_exit_hold_pair_chk
  CHECK ((exit_hold_order_id IS NULL) = (exit_hold_at IS NULL));

-- Verification — expect every row un-held.
SELECT count(*) AS held FROM trades WHERE exit_hold_order_id IS NOT NULL;  -- expect 0
