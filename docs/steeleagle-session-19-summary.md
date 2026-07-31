# SteelEagle — Session 19 Summary

**Date:** July 31, 2026 (market-hours check-in)
**Milestone:** **v2.6.1 — delta-staleness marker.** The roll signal can no longer fail silently.
**Branch:** main — committed `46e9dbb`, **pushed and auto-deployed to production 2026-07-31**
**Test baseline:** 471 → **489 passing** (+18) · `tsc --noEmit` **completely silent** for the first time

---

## What Was Accomplished

### 1. The check-in question that turned into the milestone

April, mid-session: *"I don't see the roll badges"* — with a live screenshot of the Monitor
showing two healthy condors (SPY 680/700 · 765/785 at 14% of credit, 28 DTE; GLD 345/355 ·
400/410 at 49% of credit, 21 DTE with its `CLOSE` chip).

**The absence was correct.** `RollBadge` renders three states only — `ROLL` (a short at
\|Δ\| ≥ 0.30), `REVIEW` (both shorts ≥ 0.30), `ROLL?` (≥ 0.27 approaching). Both condors were
opened at ~16Δ and neither has been tested, so `NONE` → no badge. Nothing was broken.

**But the question could not be answered from the screen, and that was the finding.** Open
item #2 on the Session 18 board — *"one market-hours load: expect `NONE`/`WATCH`/`ROLL`, not
`NO_DELTA`"* — had been carried since **Session 17**. This session finally produced that
market-hours load, and it **still could not close the item**, because:

> `NONE` (healthy) and `NO_DELTA` (no usable greeks) render **identically**. Both are nothing.

The verification owed for three sessions was **unresolvable by looking at the monitor**. That
is the argument for the whole change, and it was sitting in the open-items board the entire
time disguised as a routine confirmation.

### 2. The precedent — this exact silence already hid a real outage

Two distinct paths produce "no roll opinion", and neither was visible:

1. **`NO_DELTA` verdict** — `/quotes` answered, greeks were 0/absent. Normal after hours
   (Schwab zeroes greeks — same class as the IV=0 bug); a fault mid-session.
2. **The annotation block threw** — `getOptionDeltas` failed, the positions route's isolating
   `try/catch` logged server-side, and every condor came back `rollVerdict === undefined`.

Case 2 **already ran in production**. The v2.4 audit of `lib/schwab/quotes.ts` found
`getOptionDeltas` building `/marketdata/v1/quotes?…` while `marketGet` already prepends that
prefix — **every call 404'd**. The only symptom was roll badges that quietly never appeared,
plus a log line nobody reads. It was caught by unrelated code-reading, not by the monitor, and
the comment recording the fix says so in as many words.

A silent false negative on the only roll signal is the wrong failure direction for a system
whose entire posture is *refuse, don't guess*.

### 3. v2.6.1 — the marker (spec: `docs/steeleagle-v2-6-1-delta-staleness-spec.md`)

| Market state | Marker | Meaning |
|---|---|---|
| Mon–Fri 09:30–16:00 ET | `Δ STALE` amber, **dashed** | Deltas should be live and aren't. Roll alerts are **not running** on this row. |
| Otherwise | `Δ —` dim slate | Greeks zeroed after the bell. Expected, not a fault. |

Design constraints, all deliberate:

- **Never mimics `ROLL`.** Dashed border + `Δ` prefix, sitting beside a solid amber pill that
  already means "roll the untested side". This one means *unknown*, not *act*.
- **Not nightly noise.** The after-hours variant is deliberately low-contrast, and the banner
  clause counts **in-hours only**. An alarm every evening trains the operator to ignore the
  one that matters — the same reasoning behind `PlacementPausedBanner` being persistent while
  this one is not.
- **Truthful in both states**, not only when broken. A badge that appears solely on failure is
  indistinguishable from a badge that was never implemented.

### 4. Files

- **`lib/strategy/market-hours.ts`** (new, pure) — `isRegularMarketHours(now)`, ET wall clock
  via `Intl` with **`hourCycle: 'h23'`**, not `hour12: false` (the latter renders ET midnight
  as `"24"` in some ICU builds → 1440 minutes → reads as after-hours on a technicality).
  The clock is always an argument; nothing reads `new Date()` internally.
  **No holiday calendar, by design** — on the ~9 holidays a year (and 1:00 PM early closes)
  this reports open and shows a false amber on a day April isn't trading. Never a silent miss
  on a day she is. Same fail-loud direction as `getWorkingAndRecentOrders` throwing rather
  than degrading to `[]`. A test asserts the gap explicitly, so a future calendar has to flip
  it consciously rather than silently reversing the choice.
- **`lib/strategy/roll-alert.ts`** — `deltaMarker(verdict, now)` is **one predicate**, shared
  by the row marker and the banner clause (same discipline as `isPriceableStructure`), plus
  `noDeltaVerdict()` and `countStaleDeltas()`. Returns null for any verdict that carried
  usable deltas *and* for `undefined` — which after §5 means "not a condor", nothing else.
- **`app/api/positions/route.ts`** — the roll-annotation `catch` now stamps every unannotated
  condor with `noDeltaVerdict(underlying, 'Delta fetch failed: …')`. The isolating try/catch
  stays (a `/quotes` hiccup must never take down the monitor); it just can no longer swallow
  the fact that it fired. The real error text rides into the marker tooltip — single-operator
  app, so surfacing it is the useful choice.
- **`components/positions/PositionsMonitor.tsx`** — `<DeltaMarker>` in both renderers (mobile
  card + desktop row); `AlertBanner` gains `N with roll alerts stale`, and that clause alone
  now raises the banner.

### 5. Structural consequence

`rollVerdict === undefined` on a condor is now **impossible**. The UI's two ignorance-cases
collapsed into one, so the marker needs no `kind` check and no second code path.

### 6. Incidental — the pinned TS5097 was an accident, not a convention

CLAUDE.md carried *"Known-good noise: `roll-alert.test.ts` emits one TS5097 error. Pinned;
not a failure."* It was a lone `.ts` import extension. **Every other lib test file** — 20-odd
of them — imports extensionless. Dropped it.

`tsc --noEmit` is now **completely silent**, so any future TS5097 is real rather than
something to squint at against a remembered exception. A permanently-tolerated error in the
one gate that catches type drift is a gate with a hole in it.

Also caught during the gate run: `.next/types/cache-life.d 2.ts` and `routes.d 2.ts` — Finder
collision artifacts, in the **build output**, not the source tree. `rm -rf .next` clears them;
the `find app components lib -name "* 2.*"` source sweep was clean. Noted in CLAUDE.md so the
next occurrence isn't mistaken for a type error.

### 7. Live-money check-in items (April, in-session)

- **Order `1007258139199` filled on a GTC trade.** Traced the path and confirmed the 4:15 PM CT
  sweep will take it: `planExitSweep` branch (a) → `status === 'FILLED'` and not partial →
  `toReconcile` → `closeTrade(…, { source: 'schwab_fill', schwabOrderId })` with
  `closeReason: 'profit_target'`. The 180-day `fromEnteredTime` lookback covers a GTC placed
  weeks ago. Two deliberate refusals stand in the way and neither is a bug: a partial fill
  (filled **and** remaining > 0) flags without writing, and a fill-vs-trade contract-count
  mismatch flags without writing.
  **This is the second live L4** (the first, TLT, closed the item in Session 18).

### 8. The cron has never run when the docs said it did

Surfaced while advising April on deploy timing, then confirmed against `vercel.json`:
`"schedule": "15 21 * * 1-5"` → **21:15 UTC**, and Vercel crons are UTC-only.

**"4:15" was correct all along — in CENTRAL time. The "ET" suffix was the error**, and it was
in *every* doc from Session 2 onward. 21:15 UTC is 4:15 PM CDT (= 5:15 PM EDT), so the sweep
has been running **75 minutes** after the close, not 15.

The consequence is in the future, not the past: the schedule is pinned to UTC while the market
close moves with DST, so **at the November change the margin drops from 75 minutes to 15**.
That was the original design intent, but it has never been exercised — the project has run
entirely in CDT. A UTC cron cannot hold a fixed local time year-round; the only real choice is
which season to favor. Full truth table and the two options in **tech spec v2-3 §4.0**.

Corrected repo-wide: 14 docs + 8 source files, all wall-clock times now stated in **CT** (the
operator's timezone). Market mechanics that are genuinely Eastern — the 09:30–16:00 session in
`market-hours.ts`, the 1:00 PM early closes — stay in ET, because that is what the exchange
runs on. **`vercel.json` was deliberately not touched:** the behavior was never wrong, only its
description, and changing a live cron schedule is a separate decision with its own timing.

---

## Gates

`tsx --test` **489 passing** (+18: 11 market-hours, 7 delta-marker) · `tsc --noEmit`
**completely clean** · `rm -rf .next && npm run build` clean · eslint clean on all four
changed files · `* 2.*` source sweep empty.

Baseline verified by measurement, not by trusting the board: stashing the tracked changes
returned 482 with the untracked new test file still present → 471 true baseline, which
matches the Session 18 board exactly. (CLAUDE.md's "410 tests" and "214 passing" were both
stale; corrected to 489.)

---

## Key Learnings

- **An indicator that renders nothing for "fine" and nothing for "I have no idea" is not an
  indicator.** It reports only the states it was designed to celebrate. The gap was invisible
  precisely because the healthy case is the common one — every quiet day confirmed the wrong
  hypothesis.
- **A verification that has been owed for three sessions may be un-performable, not
  un-performed.** Item #2 was carried from S17 through S18 as a routine "do a market-hours
  load". The load finally happened this session and answered nothing. When a confirmation
  keeps slipping, check whether the observation is even *possible* before scheduling it again.
- **The operator's confusion was the bug report.** "I don't see the roll badges" was, on its
  face, a misunderstanding of the design — and the design was correct. The real content was
  that a correct design produced an unreadable screen. Answering only the literal question
  ("that's expected, they're healthy") would have closed the ticket and left the hole.
- **A caught bug leaves a shaped hole.** The v2.4 `/quotes` 404 was fixed, and the fix comment
  even documented *how* it had hidden — but the hiding mechanism itself was left in place, so
  the next failure on that path would have been equally invisible. Fixing the instance is not
  fixing the class; ask what made it undetectable, not just what made it wrong.
- **A tolerated error in a gate is a gate you have to remember to read correctly.** One pinned
  TS5097 meant every future run required distinguishing "the known one" from a new one — by
  memory, under time pressure, against live money. It cost one `sed` to delete the exception
  permanently.
- **A number that looks right is the hardest kind of wrong.** "4:15 PM ET" survived 19 sessions
  and two full doc refreshes because *4:15* was correct — a post-close sweep at 4:15 reads as
  obviously sane, so nobody checked the suffix. The error was only findable by computing from
  `vercel.json`, which is the one artifact that was never wrong. Where a doc and the code
  disagree the code wins — but only if someone converts the units.
- **Choose the direction of the wrong answer, then write it down.** The holiday calendar was
  omitted on purpose: a false alarm on a closed day is strictly better than a silent miss on
  an open one. That's only a decision if it's recorded — otherwise it's a bug someone
  "helpfully" fixes later. It's in the module header, the spec, and a test.

---

## Open Items Board (2026-07-31, post-Session 19)

**Deployment confirmed:** `46e9dbb` pushed to `origin/main` 2026-07-31; Vercel's Git
integration auto-deploys production on push to `main`. Local gates were green at the pushed
commit (489 tests · `tsc` clean · `rm -rf .next && build` clean). **Vercel's own build result
was not observed from the session** — confirm on the dashboard, and treat items #2 and #15
below as pending that confirmation.

Carried from the Session 18 board, with this session's movement marked:

1. **First post-close run on the new IV basis** — unchanged. IV lines should read a real percentage
   at 28–52 DTE; watch **function duration** (29 chain fetches with date filters + 10 strikes).
2. ~~**Roll-badge live confirmation**~~ — **now ANSWERABLE, and the answer is owed on the next
   market-hours load after v2.6.1 deploys.** No `Δ STALE` marker on an open condor = deltas
   are live = the `getOptionDeltas` 404 fix confirmed working. Absence of a `ROLL` badge is
   no longer evidence of anything. **Carried until that load happens.**
3. **Calibration completes ~Aug 27–28** for every symbol — unchanged.
4. **v2.4 step 11 — manual ladder on the first qualifying XSP setup** — unchanged; calendar-
   blocked on the same clock. Sanity-check the first XSP liquidity PASS against TOS spreads.
5. **v2.5 journal stamp** — still unit-tested only; needs a real fill (see #12).
6. **Fee table** — index `perContractFee` values remain estimates.
7. **`minWingWidth` for indices** — tune against a real full-chain XSP look once calibrated.
8. **V6 (index positions-endpoint payload)** — unpinned until a real XSP fill.
9. **Sub-$1 4dp NET_DEBIT acceptance** — unverified until the first sub-$1 placement.
10. **Pre-existing ESLint errors** (4) — carried deliberately (the two `set-state-in-effect`
    ones would change page-load behavior on live pages for a lint-only gain).
11. ~~**Doc-refresh queue**~~ — cleared in S18; CLAUDE.md refreshed again this session.
12. **First real ENTRY fill** — still hasn't occurred; still the only way to validate both
    `recordFillAction` and the v2.5 override journal stamp.
13. **Roll-event editing** — out of scope; roll ENTRY hardened, roll REPAIR has no path but SQL.
14. **The placement panel's auto-journal window is a data-loss path** — `MAX_POLLS = 40` ×
    `POLL_MS = 3000` ≈ 2 minutes, only while mounted. Unscheduled. **Worth re-reading in light
    of this session:** it is the same defect shape — a failure whose only symptom is the
    absence of something that was never guaranteed to appear.
15. **NEW — `Δ STALE` has no live confirmation and structurally can't get one on demand.** The
    after-hours `Δ —` path is confirmable tonight (both condors, any load after 3:00 PM CT).
    The in-hours amber path only appears during a real `/quotes` outage; it is pinned by unit
    tests and by the route's catch-path test, and that is the most it can be.

16. **NEW — the cron's post-close margin drops from 75 min to 15 min at the November DST
    change.** `15 21 * * 1-5` is UTC-pinned; the market close is not. Nothing is wrong today.
    **Decide before November:** stay (first-ever 15-minute margin, untested against live order
    settlement) or move to `15 22 * * 1-5` (≥75 min in both seasons, later sweep in summer).
    Tech spec v2-3 §4.0 has the table. Note this also moves the IV snapshot, not just the sweep.

---

## Pickup checklist

```
SteelEagle post-Session 19 (2026-07-31). State: v2.6.1 delta-staleness marker
shipped AND DEPLOYED (46e9dbb) — the roll signal can no longer fail silently; "healthy" and "no roll
opinion at all" are now distinguishable on the Monitor. tsc --noEmit is
COMPLETELY clean (the old pinned TS5097 was a stray .ts import, deleted).
489 tests · 1/2 cron slots · no pending migrations · ALL symbols
recalibrating from 2026-07-31, complete ~Aug 27-28.

FIRST, ask April:
- Did the 4:15 PM CT sweep journal order 1007258139199 hands-off? (2nd live L4:
  expect the trade closed with source schwab_fill, nothing in flagged[])
- After 3:00 PM CT: do BOTH condors show a dim "Δ —"? That confirms the
  whole marker path end-to-end without needing an outage.
- On a MARKET-HOURS load: any amber "Δ STALE"? If none, item #2 finally
  closes — deltas are live and the v2.4 /quotes 404 fix is confirmed.
- Did the first post-close run on the new IV basis look right? Watch cron
  FUNCTION DURATION.
- Any real ENTRY fill yet? (validates recordFillAction AND the v2.5
  override journal stamp — a test order cannot reach either)

Read first: docs/steeleagle-v2-6-1-delta-staleness-spec.md,
docs/steeleagle-session-18-summary.md (incl. Addendum), CLAUDE.md
```
