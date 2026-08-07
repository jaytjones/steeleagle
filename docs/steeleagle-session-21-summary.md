# SteelEagle — Session 21 Summary

**Date:** August 7, 2026
**Milestone:** **v2.9** sweep run visibility
**Branch:** main — uncommitted at time of writing
**Test baseline:** 534 → **571 passing** (+37) · `tsc --noEmit` silent · build clean
**Migration pending:** `migrations/2026-08-07-sweep-runs.sql` — apply in Neon before deploy

---

## The shape of this session

Session 20 ended with a pickup checklist of questions for April. Running it produced a
**new CRITICAL on a different trade**, and chasing that one down overturned a documented
conclusion from three days earlier.

The through-line, and it is the inverse of Session 20's: **every detector fired
correctly, and none of it reached anyone.**

---

## 1. What the read-only checks found

`scripts/reconcile-journal.ts` at 07:01 CT:

| Trade | Verdict | |
|---|---|---|
| SPY 2026-08-28 | `MATCH` | Session 20's biggest open item — **closed by April** |
| SPY 2026-09-18 | `MATCH` | the $2.58 GTC appeared (`1007487397392`) — open item #3 resolved |
| GLD 2026-09-18 | **`DRIFT` critical** | journal 1 contract, account 2 — still open |
| **SPY 2026-09-11** | **`DRIFT` critical** | **NEW** — journal 725/740, account 735/750 |

SPY 2026-09-11 was not in Session 20 at all. Order `1007478016582` (Aug 5, 10:39 AM CT,
`REPLACED`) shows the put side rolled 725/740 → 735/750. Never journaled.

**The sweep then built the GTC from the stale journal, twice:**

| Order | Entered (CT) | Price | Result |
|---|---|---|---|
| `1007487397396` | Aug 5, 5:05 PM | 2.40 | **REJECTED** |
| `1007505458280` | Aug 6, 5:05 PM | 2.40 | **REJECTED** |

Both: *"This order may result in an oversold/overbought position in your account."*

---

## 2. The correction — what actually stopped the bad order

Session 20 §4a stated the SPY 2026-08-28 stale-journal close "did not place… what
prevented it was `PLACEMENT_MIN_DTE = 24`."

**That is wrong.** Order `1007468901538` was **placed** Aug 4 at 4:17 PM CT carrying the
stale 720/740 legs at $2.89, and Schwab **REJECTED** it with the same oversold message.

> The last line of defense against a stale-journal close is **Schwab's own position
> validation** — not our calendar, and not a guard we wrote.

This matters for two reasons.

**First**, Decision 5 (reconciliation flags, does not block) was reasoned partly on "a
heuristic in front of a mechanical chain that already works." The chain does hold, but
its load-bearing member turned out to be external and undocumented.

**Second, and worse: Schwab's guard only covers STRIKE drift.** It fires because the
legs are not held. The GLD case — journal 1 contract, account 2 — produces an order
Schwab considers perfectly valid, and it *will* fill, closing 1 of 2 contracts and
leaving a condor invisible to the app (Session 20 §4b).

**April reviewed this and Decision 5 stands: flag, never block.** A false positive
suppressing a legitimate GTC is still the worse failure. The conclusion is unchanged;
only its stated rationale needed correcting.

---

## 3. The actual gap — detection worked, delivery did not

Every part of the system did its job:

- reconciliation raised `DRIFT` as critical, both runs
- the planner queued the placement (correctly — it is not allowed to consult
  reconciliation)
- `route.ts` confirmed the order status immediately, saw `REJECTED`, and **refused to
  store the id** — which is why it retried cleanly the next day
- the flag landed in `report.flagged` every single time

**`ExitSweepReport` is the HTTP response body of a cron invocation.** It is returned,
`console.log`'d, and discarded. No table stores it, no route reads it, no component
renders it. Six correct CRITICAL flags over three days reached nobody.

This is the v2.6.1 lesson one layer further out. v2.6.1 fixed *"healthy" and "no opinion
at all" render identically* inside the app. This fixes *the sweep screamed and the app
was not listening.*

---

## 4. v2.9 — sweep run visibility

`lib/strategy/sweep-report.ts` (pure, 31 tests) · `sweep_runs` table ·
`GET /api/sweep-runs` · `components/SweepBanner.tsx`.

### The wallpaper hazard, and why severity is stamped not inferred

`flagged[]` is **not homogeneous**. Two of the planner's flag sites are permanent steady
state by design: a multi-root index (SPX/NDX/RUT) and an unpinned order fixture both
refuse auto-placement on *every run, forever*, and that is correct decided behaviour
(v2.4). If those counted as critical, the banner would be red from the day April opens
an SPX condor to the day she closes it — **and a banner that is always red is exactly as
useful as no banner.** That is the same failure this milestone exists to fix, inverted.

The fix is **not** to string-match the reason text — reasons are prose written for a
human, and re-wording one must never silently re-classify it. `toFlag` now carries
`severity: 'critical' | 'routine'`, stamped at the branch that produced it.

The split inside the unpriceable branch is the one that matters:

- **routine** — symbol-level refusals only, decided by the **instrument registry**
  (`hasAmbiguousRoot`, `isOrderFixturePinned`), the single source of truth for
  symbol-level facts.
- **critical** — every STRUCTURAL refusal: a diagonal, a leg rolled closed and never
  reopened, or strikes not ordered `LP < SP <= SC < LC`. **That last one is the v2.7
  defect class** — before v2.7 it produced `report.errors` every sweep, forever, with no
  exit placed. Demoting it to routine alongside the index refusals would have re-buried
  exactly the bug v2.7 dug up.

`severity` is **required, not optional-with-default**: a new flag site cannot be added
without the compiler asking which it is. A default would answer that question by
accident.

### Freshness — a cron that stops firing produces no report

A report-rendering banner cannot show "there was no report." So freshness is derived
from the clock instead: `expectedRunsBetween()` counts weekday cron instants (21:15 UTC,
Mon–Fri), weekend-aware, so Friday → Monday is one expected gap rather than three misses.

**2 missed runs = stale.** 1 would be correct in principle and false-alarm in practice:
observed Vercel Hobby drift is ~50 minutes (21:17 UTC Aug 4; **22:05 UTC Aug 5 and Aug
6** against a 21:15 schedule). Two whole scheduled runs passing with nothing recorded is
not something drift explains.

**No holiday calendar**, and unlike `isRegularMarketHours` it needs none: the Vercel cron
is weekday-based, not market-based, so it fires on Thanksgiving too and a holiday cannot
produce a false alarm.

### Three states, never collapsed

`critical` red (every line shown, none truncated) · `warning` amber · `ok` **dim but
rendered**. The quiet "clean" line matters as much as the red one — a banner that renders
nothing when healthy is indistinguishable from a banner that is broken.

A failed `/api/sweep-runs` fetch renders the explicit *"NOT a clean bill of health"*
state, never nothing.

### Isolation

`recordSweepRun` is called **after** `runExitSweep` and outside it. By then every order
decision is made and executed, so a DB failure can only lose the record — never disturb
the live-money path. **`sweep_runs` is WRITE-ONLY from the cron and READ-ONLY everywhere
else; nothing in the placement path may read it.** A *history* of flags is weaker
evidence than a live one, and Decision 5 governs both.

---

## 5. Resolved mid-session by April

Both criticals cleared while the build was in progress (07:01 → 07:29 CT):

- **SPY 2026-09-11 roll journaled** — now `MATCH` at 735/750/775/790, credit $481 → $548.
- **Second GLD 2026-09-18 condor journaled** as its own trade, per Session 20
  decision #6. GLD now reports **`UNCOMPARABLE` ×2** — precisely as that decision
  predicted. Drift detection on GLD is suspended until one of the pair closes.

Reconciliation: **match 3 · drift 0 · phantom 0 · uncomparable 2 · no criticals.**

---

## 6. Stale docs corrected (code wins)

- **v2.3.1 and v2.3.2 both shipped** (`d088f53`, `8b9ab14`). CLAUDE.md and Session 20
  open item #6 still listed v2.3.1 as queued — two sessions after the code landed.
- CLAUDE.md said 500 tests; the real baseline was 534.
- The SPY 2026-08-28 "OPEN — April action" block was already resolved.

The repo rule earned its keep again: **check `git log -- <file>` before believing a queue
entry.**

---

## 7. Open items

1. **Apply `migrations/2026-08-07-sweep-runs.sql` in Neon**, then deploy. Until then
   `/api/sweep-runs` 500s and the banner shows the explicit "could not load" state.
2. **Verify the v2.9 first live run** — one `sweep_runs` row, banner renders it.
3. **SPY 2026-09-11 should get a $2.74 GTC** at the next sweep (MATCH, 35 DTE,
   `exitOrderId` null). Absence is a signal.
4. **GLD trade B's GTC must be placed by hand** — the pre-place guard sees trade A's
   standing `1007448830391` on the shared `underlying|expiration` key and flags. That
   flag is `critical`, so the banner stays red until it is placed and `exit_order_id`
   backfilled. Actionable, not wallpaper — but worth knowing before the first run.
5. **SPY 2026-08-28 butterfly hit 21 DTE today (Aug 7)** with no standing exit —
   manual GTC at $4.30, or close. Below `PLACEMENT_MIN_DTE`, so the sweep will not place.
6. **Reconciliation still cannot see credit.** Legs and counts only; a trade journaled at
   the wrong credit remains invisible to everything. (Carried from Session 20 #8.)
7. **XSP place-and-cancel fixture** (v2.4 step 7) — unchanged.
8. **Board #17** — expiration date on the Monitor (carried from Session 19).

---

## Pickup checklist

```
SteelEagle post-Session 21 (2026-08-07). State: v2.9 sweep run visibility
built, gates green, NOT YET COMMITTED OR DEPLOYED.
571 tests · 1/2 cron slots.

*** MIGRATION PENDING: migrations/2026-08-07-sweep-runs.sql ***
Apply in Neon BEFORE deploying v2.9.

STRUCTURAL RULE: LP < SP <= SC < LC. SP > SC is never valid.

FIRST, ask April:
- Was the migration applied and v2.9 deployed?
- Did the dashboard banner render the sweep? (Blank = the fetch failed;
  it should show an explicit "not run" state, never nothing.)
- Did SPY 2026-09-11 get its $2.74 GTC?
- Was GLD trade B's GTC placed by hand and exit_order_id backfilled?
- SPY 2026-08-28 butterfly (21 DTE Aug 7) — closed, or GTC at $4.30?

RUN THIS FIRST:
  npx tsx --env-file=.env.local scripts/reconcile-journal.ts
  (read-only; exit 1 = critical. Expect UNCOMPARABLE x2 on GLD —
   that is the DECIDED state, not a fault.)

DO NOT:
- Let anything in the placement path read report.reconciliation OR the
  sweep_runs table. Flag, never block (April, 2026-08-04, reaffirmed
  2026-08-07 after learning Schwab's rejection is what actually stops a
  stale-journal close — and that it does NOT cover contract drift).
- Infer flag severity from the reason prose. It is stamped at the producer.
- Demote a STRUCTURAL unpriceable refusal to 'routine'. Only the two
  symbol-level refusals are routine. Structural = the v2.7 defect class.
- Loosen the butterfly refusal in order-ticket.ts (entry stays unpinned).
- Add a second leg-derivation path. currentStructure is the only one.

Read first: lib/strategy/sweep-report.ts header, CLAUDE.md,
docs/steeleagle-session-20-summary.md §4a (its causal claim is CORRECTED
in §2 of this doc — Schwab rejected the order; the 24-DTE floor did not
prevent it).
```
