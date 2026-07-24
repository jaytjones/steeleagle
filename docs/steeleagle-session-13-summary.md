# SteelEagle — Session 13 Summary

**Date:** July 23, 2026
**Milestone:** v2.1.1 Earnings Sleeve Removal — SHIPPED, live-verified in prod · v2.2 spec DRAFTED (unreviewed)
**Branch:** main

---

## What Was Accomplished

### 1. v2.1.1 — Tactical Earnings Sleeve removed (shipped + closed out)
Built from actual repo source at `f690cd9` (repo cloned, dependencies traced with grep + tsc — no guessed field names).
- **Deleted (18 files):** earnings cron + route, earnings-scanner route, `lib/earnings/*`, `lib/db/earnings.ts`, `lib/schwab/earnings-chain.ts`, `lib/strategy/{earnings-condor,earnings-entry-window,earnings-gate,earnings-watchlist,expected-move}` + tests, `components/earnings/*`. Three of these (`earnings-chain`, `db/earnings`, `expected-move`) were found only by tracing — not in the original inventory.
- **Modified (8 files):** `vercel.json` (cron removed → **1/2 slots, freed slot held open for nothing — stays free**), dashboard page (all earnings/crisis wiring out), `lib/db/journal.ts` (`hadRecentCoreStop` removed — only consumer was the earnings scanner), `lib/journal/types.ts` (**`SLEEVES` collapsed to `['core']`** — April confirmed zero historical earnings rows, so the interim read/write split was dropped for the full simplification), NewTradeForm (sleeve picker deleted, `'core'` hardcoded), order-actions + importer (comments/types narrowed), schema file (`earnings_calendar` DDL out, sleeve CHECK narrowed).
- **Neon (April, verified):** `count(*) where sleeve='earnings'` → 0 confirmed → `DROP TABLE earnings_calendar` + `trades_sleeve_check` swapped to `CHECK (sleeve IN ('core'))`.
- **Vercel:** Crons tab confirmed showing only `snapshot-iv`. `FINNHUB_API_KEY` not found in env (accepted as-is: free-tier key to public data, zero blast radius; the code that read it is gone).
- **New pinned test baseline: 148 passing** (was 207; −59 earnings, compose-fill-notes' 5 retained). Build clean local, prod loads clean.

### 2. Deployment friction findings (repo-wide principles)
- **VS Code TS server holds stale module resolution after file replacement** — "Cannot find module" cascades across the workspace resolve with *Restart TS Server*. Editor "no problems" is not the gate; repo-local `tsc --noEmit` is.
- **`rm -rf .next` before the tsc gate after any changeset that deletes routes.** The tsconfig includes `.next/types` (typed routes), so a stale build dir fails typecheck against deleted route files.
- **macOS Finder collision artifacts (`"name 2.ext"`)** appeared inside `.next/` during file drop-in — harmless there, but a `find app components lib -name "* 2.*"` sweep is now part of the apply checklist (a stray `page 2.tsx` under `app/` would become a real broken route).
- Sandbox ESLint showed 5 errors that April's local run doesn't — plugin-version drift from a fresh install; local ESLint remains the gate of record. Sandbox `npm run build` can't run (Google Fonts fetch blocked); local build is the gate.

## Key Decisions (v2.2 design, all April-confirmed this session)
1. **Cron-sweep GTC placement is the PRIMARY path** (not at-fill): the sweep reads *journaled* net credit, so it ships before Layer 4 closes. **At-fill placement = fast-follow** after the first real fill validates `recordFillAction`. Idempotent by `exit_order_id IS NULL` guard.
2. **Single-cron topology:** all three duties (reconcile → 21-DTE alert → placement sweep) fold into 4:15 `snapshot-iv`, per-item try/catch-isolated. The old 12:00 UTC leg is dropped (redundant with the Positions Monitor's live DTE alerts + same-day 4:15 reconcile). **Second cron slot stays open.**
3. **21-DTE: alert-only. The cron NEVER cancels working orders** (April: canceled GTC + forgotten manual close = unprotected position; stale GTC fails safe). Alert text must include "cancel standing GTC [id]".
4. **`exit_order_id` column on `trades`** for the standing-exit association.
5. **v2.3 identified: close-position flow from the Monitor** (cancel-GTC-then-close as one sequenced action) — structurally eliminates the stale-GTC hazard; likely higher-value than the at-fill fast-follow. Distinct naming needed vs the journal's record-a-close form.

## Files / Artifacts
- `steeleagle-v2-2-auto-exit-spec-DRAFT.md` — **UNREVIEWED**; resolves pickup-note open questions 1–6 (§5); build order in §7 (golden fixture of a real GTC NET_DEBIT close is task 1, April/manual).
- v2.1.1 changeset applied directly to the repo by April (18 D + 8 M, −2,416 lines net).

## Open Items Board (post-Session 13)
1. **§8 #5 / de-facto L4 STILL OPEN:** no real entry fill has occurred yet. Gates only the at-fill fast-follow, not v2.2 proper. First fill → verify auto-journal vs TOS.
2. **v2.2 spec awaits April's review** — first action at pickup; then golden fixture, then build order §7.
3. **Tech Spec/PRD staleness widened** by v2.1.1 (F18 removal, cron count, sleeve enum). Queue unchanged.
4. Rate-limit doc reconciliation — unresolved, low priority.
5. `user_settings` still not in the committed schema file.

## Pickup checklist

```
Starting SteelEagle v2.2 — auto-exit build.
FIRST: April reviews steeleagle-v2-2-auto-exit-spec-DRAFT.md (unreviewed draft).

Read first:
- steeleagle-v2-2-auto-exit-spec-DRAFT.md   (the plan)
- steeleagle-session-13-summary.md           (this doc; v2.1.1 ship + decisions)

Confirm clean state:
1. npx tsx --test "lib/**/*.test.ts"   -> expect 148 passing.
2. rm -rf .next && npm run build        -> clean.
3. ./node_modules/.bin/tsc --noEmit     -> clean (roll-alert.test.ts TS5097 noise ok).

Ask April at pickup:
- Spec red lines? (esp. §5.3 roll behavior and §4.4 surfacing scope)
- Has the first real entry fill happened yet?
- Golden fixture: ready to place the one real GTC NET_DEBIT close in TOS? (build task 1)
```

**Final state:** v2.1.1 live in prod · 148 tests · 1/2 cron slots · Neon migrated · v2.2 spec drafted, unreviewed.
