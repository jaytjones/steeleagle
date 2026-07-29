-- ============================================================
-- Migration: placement pause toggle (2026-07-28)
-- Adds user_settings.pause_exit_placement — when true, the 4:15
-- exit sweep skips step (c) PLACE only. Reconcile, clear, and
-- 21-DTE alerts always run (they are Schwab-read-only + journal
-- bookkeeping). Standing GTCs are NOT touched by pausing: they
-- remain working at Schwab and can fill while paused (reconcile
-- journals those fills as normal).
--
-- Fail-safe direction: DEFAULT false = normal operation. A cron
-- settings-read failure also resolves to NOT paused — a transient
-- read hiccup must never silently disarm exit placement.
--
-- Companion commit folds the full user_settings table definition
-- into supabase-schema.sql (standing debt item — the table was
-- applied directly in Neon at v1.2 and never committed).
-- ============================================================

ALTER TABLE user_settings
  ADD COLUMN pause_exit_placement boolean NOT NULL DEFAULT false;
