# SteelEagle — Session 28 Summary

**Date:** October 31, 2026
**Milestone:** **v2.15 auto-journal ROLLS — built and shipped** · **v2.16 roll-price editing,
auto-journal ENTRIES, split-roll prefill — built** · **`initial_bpr` backfill** · **PRD + tech
spec refreshed to v2.16**
**Branch:** main
**Test baseline:** 885 → 958 (v2.15) → **999 passing** · `tsc --noEmit` silent · build clean ·
eslint clean on touched files except the pre-existing `set-state-in-effect` in
`app/journal/page.tsx`
**Migrations:** `2026-10-31-exit-hold.sql` (v2.15) — **applied in Neon by JJ** before the v2.15
deploy. v2.16 needed none.

---

## The shape of this session

A long build session in five parts:

1. Build v2.15 from the Session 27 spec once JJ answered its four open questions.
2. Apply the migration, deploy, and verify reads against the live DB.
3. Pre-code analysis of the three queued items (roll editing, auto-entries, split rolls). JJ
   answered four questions, then the build.
4. Correct 11 trades whose BPR held a $0.00 placeholder.
5. Refresh the PRD and tech spec, which were fourteen milestones behind.

---

## 1. v2.15 — auto-journal ROLLS (shipped)

### JJ's answers to spec §8 (2026-10-31)
1. **No roll-edit path yet:** ship with the hold as the safeguard, queue price-only editing.
   That editing was then built as v2.16.
2. **4+4 rolls:** admit.
3. **Hold escalation:** critical after **3** unconfirmed runs.
4. **Butterfly results:** intended.

### Findings the spec did not have, each now a condition
- **A — already journaled.** `closeOwners` matches on events that ever put a leg in place, and
  a rolled trade stays open. So a roll JJ had already journaled by hand still had an owner.
  Without A, the cron would have written her rolls twice.
- **9a — the closing legs must be what the journal holds now.** The fold vacates a role on
  `roll_close` without checking its strike.
- **H — no standing GTC and no prior hold.** `rollTrade` nulls `exit_order_id` silently.
- **R — one roll per trade per interval.** Accepted rolls are carried forward in-plan, so a
  second roll is refused by name rather than skipped silently.
- **The provenance note goes on each event.** `rollTrade`'s `notes = COALESCE(...)` would have
  overwritten JJ's own trade notes.
- **Pause defect.** The `pause_exit_placement` branch `return`ed inside step (c), so the
  auto-journal never ran on a paused night, and no "did not run" flag fired either. Step (d) is
  now `runAutoJournal()`, which runs on both paths.

### Proof
- Pinned `1007450735138`, `1007465290239` and `1007511371504`, each from a read-only dump.
  `1007465290239` is the roll that made the SPY 08-28 butterfly.
- Roll replay over the live ledger: **6 would write, 5 exact**, 2 refused (the GLD 2-lot pair),
  2 skipped (June AAPL).
- **One hand-entry error found:** trade `7dc07054`, order `1007483420023`, journaled SP
  5.79 / LP 3.66 against Schwab's 5.77 / 3.69, overstating the credit by about $5.
  **JJ: leave it.**
- JJ applied the migration, committed (`ee44648`, `742076b`) and pushed. A read-only check
  confirmed all 23 trades read cleanly with the hold fields, none of them held.

---

## 2. Re-login (CT)
JJ re-authorized. The stored deadline is now **Sat, Nov 7, 4:23 PM CT**, which covers every
weekday sweep through Fri Nov 6. DST ended Nov 1, so the cron is now **due 3:15 PM CT**.

---

## 3. v2.16 (built this session)

### Evidence that shaped the scope (read-only, live)
- **Entries:** 22 of 23 entries came from Schwab fills with an order id (Import), journaled
  0–161 h after filling. `recordFillAction` has **never** been used in production, and **0 of 23**
  entries record a delta.
- **Scale-ins:** both GLD scale-in entries were hand-typed. A structural dedup has the same
  blindness Import does.
- **Split rolls:** **1** in 180 days, against 10 single-ticket rolls.
- **One entry never journaled:** SPY 2026-09-30 (Aug 24), which ran start to finish with no GTC
  and no 21-DTE alert. It has expired.

### JJ's answers (2026-10-31), all four recommendations
1. **Roll edit with a standing GTC:** refuse; cancel the GTC first.
2. **Auto-entry:** hold the first GTC until confirmed.
3. **Scale-ins:** journal each as its own trade.
4. **Split rolls:** prefill only; automatic pairing deferred. The **30-minute** window is fine.

Same-day entry then roll: **no change.** The roll stays an inbox card while the entry's hold is
pending.

### Built
- **Roll-price editing:** `edit-roll.ts`, `editRollPrices`, `editRollPricesAction`, and
  **Edit Roll Prices** on the trade card.
- **Auto-entry:** `entry-from-fill.ts`, `auto-entry.ts` and pass d0.
  `createTrade(..., { holdExitPlacement })` sets the hold in the same INSERT.
- **`createTrade` duplicate guard:** refuses an entry order id that is already journaled, for
  every caller.
- **`recordFillAction` alignment:** skips cancellation records and counts a missing quantity
  as 0.
- **Split-roll prefill:** `split-roll.ts`. The OPEN half now borrows the CLOSE half's trade;
  before this it could open no form at all.
- **Hold wording** generalized (entry or roll), plus the report's `entries` block, NOTE line and
  its own did-not-run backstop.

### Proof
**Entry replay** (`scripts/dry-run-auto-entry.ts`, journal-as-of by `createdAt`): **27/27 would
write, 12 exact, 0 leg mismatches, 0 refused.** That includes the GLD scale-in
`1007457102802`, which would have become its own trade and matches JJ's hand-typed `9b3f575a`
exactly, BPR included. The replay was first run by `openedAt`, which falsely refused it: the hand
copy's `openedAt` predates the fill, but the copy did not exist that night.

---

## 4. `initial_bpr` backfill (JJ approved)
- **Low risk:** no gate reads `initial_bpr`. That also settles Session 27's "possibly stale"
  `types.ts` comments: they were stale, and are corrected.
- **Method:** `scripts/backfill-entry-bpr.ts`. It defaults to a dry run, derives `entryBpr` from
  each trade's own entry legs, runs in one transaction, and only updates rows still at
  `initial_bpr = 0`.
- **Result:** **11 trades, all closed**, all corrected. A re-run finds 0.

---

## 5. Docs
- **New:** `steeleagle-prd-v2-16.md` and `steeleagle-tech-spec-v2-16.md`, superseding the v2.3
  pair, which is kept as history. CLAUDE.md now points to v2.16.
- **Specs:** `steeleagle-v2-15-auto-roll-spec.md` §10 and `steeleagle-v2-16-spec.md` §5 are the
  as-built records.

---

## 6. Decisions locked this session
- v2.15 §8: (a) ship with the hold, edit later · admit 4+4 · escalate after 3 runs · butterflies
  intended.
- v2.16: refuse roll edits under a standing GTC · hold auto-entry GTCs · journal scale-ins as
  their own trade · split rolls prefill only, 30-minute window · same-day entry-then-roll
  unchanged.
- The pause stops step (c) only; the auto-journal runs regardless.
- Trade `7dc07054` is left as journaled.

---

## 7. Owed / queued
- **First live exercises:** an auto-entry and an auto-roll on a balanced night (NOTE →
  `GTC HELD` → confirm → placement on the next sweep), the first roll-price edit, and the
  `createTrade` duplicate guard (DB-only, so it is first exercised in production).
- **Still owed from earlier sessions:** a non-trivial balanced night (one containing a real
  fill) · v2.4 step 11 (XSP ladder) · L3-in-app · L3 ladder · the self-resolving PHANTOM
  question.
- **Not yet done:** an audit of `sweep_runs` from Aug 20 to Oct 30. No session summary covers
  that stretch.
- **Next re-login:** by **Sat Nov 7, 4:23 PM CT**. The banner turns "soon" 48 h ahead.
