# SteelEagle — Session 21 Summary

**Date:** August 7, 2026
**Milestones:** **v2.9** sweep run visibility · **v2.10** expiration selection
**Branch:** main — `512952c` (v2.9) · `fddc715` (v2.10) — **both pushed**
**Test baseline:** 534 → **602 passing** (+68) · `tsc --noEmit` silent · build clean
**Migration:** `migrations/2026-08-07-sweep-runs.sql` — **applied in Neon and verified**
(schema matches the code; write path round-tripped against the live DB — see §6)

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

## 6. Deploy — migration applied and the write path verified live

Order was **commit → migrate → push**, deliberately. Committing is a free local
checkpoint; pushing `main` triggers a Vercel production deploy of the order-placement
path, so the table had to exist first. Had it not, `recordSweepRun` would have thrown on
the first cron run — caught and isolated by design, but a spurious error on a live-money
run and a red "could not load" banner until it was fixed.

April applied the migration via the Neon SQL Editor. Verified from here, read-only:

- All 8 columns present with the intended types.
- The `severity` CHECK constraint mirrors the `SweepSeverity` union exactly
  (`'critical' | 'warning' | 'ok'`) — the DB and the TypeScript type cannot drift apart
  silently.
- `sweep_runs_ran_at_idx` is `(ran_at DESC)`, matching `getLatestSweepRun`'s
  `ORDER BY ran_at DESC LIMIT 1`.

Then a **round-trip test** against the live DB — one marked row written through
`recordSweepRun`, read back through `getLatestSweepRun`, deleted, count confirmed back to
zero. Two things it established that a unit test could not:

- **`jsonb` reorders keys.** A raw `JSON.stringify` comparison of sent vs returned
  report is `false`, and that is *not* data loss — `assert.deepStrictEqual` passes.
  Postgres normalizes `jsonb` key order on storage. Anything that later diffs a stored
  report against a fresh one must compare structurally, never by serialized string.
- **`placed[].price` survives as the string `"2.40"`, not the number `2.4`.** That field
  is typed as a string, and a silent numeric coercion through `jsonb` would have been a
  quiet, hard-to-spot bug in a forensic record.

---

## 7. Stale docs corrected (code wins)

- **v2.3.1 and v2.3.2 both shipped** (`d088f53`, `8b9ab14`). CLAUDE.md and Session 20
  open item #6 still listed v2.3.1 as queued — two sessions after the code landed.
- CLAUDE.md said 500 tests; the real baseline was 534.
- The SPY 2026-08-28 "OPEN — April action" block was already resolved.
- **`condor-builder.ts`: "the 16Δ / 5Δ / 30–45 DTE logic is untouched."** The 30–45 had
  never been true — that file does no DTE filtering at all, and selection lived in
  `chains.ts` at 28–52. This is the one that cost something: it is the reason a 28-DTE
  proposal looked normal for 21 sessions. See §8.
- CLAUDE.md said IV calibration completes "~Aug 24–25". The new-basis series starts
  **Jul 31**, so 20 trading days lands **~Aug 27**.

The repo rule earned its keep three times: **check `git log -- <file>` before believing a
queue entry, and check the code before believing a comment.** A comment describing
behaviour that lives in a *different file* is the most durable kind of wrong — nothing
that changes either file will ever contradict it.

---

## 8. v2.10 — expiration selection

April: *"the scanner is proposing condors with a Sep 4 expiration — 28 days. The preferred
DTE is 30–45. Additionally, if a monthly expiration is available, that should be the
preferred expiration."*

### Where the 28 came from

[chains.ts:99-100](../lib/schwab/chains.ts#L99-L100) — filter to 28–52 DTE, sort ascending,
take the first with contracts on both sides. Nearest-first, so Sep 4 at 28 DTE.

`condor-builder.ts` carried a comment reading *"the 16Δ / 5Δ / 30–45 DTE logic is
untouched."* **The 30–45 was aspirational and had never been true** — that file does no DTE
filtering at all. A third stale-doc find this session.

### The trap

`getOptionChain` serves two consumers, and `atmIv` is read off **whichever expiration it
picks**:

- scanner → `chain.atmIv` → `calculateIVRank` + displayed `currentIv`
- IV cron → `chain.atmIv` → `iv_history`, basis `atm_28_52dte`

That coupling *is* the v2.6 fix. And `iv-basis.ts` leaves standing orders: change what is
measured → **mint a new basis value**. Cost, measured not assumed: `iv_history` holds
**5 days × 28 symbols** on the current basis (started Jul 31, so 20 trading days lands
**~Aug 27**, not CLAUDE.md's optimistic "~Aug 24–25"). A basis change zeroes that and
pushes the first usable IV Rank to **~Sep 10**.

It would also make the measurement *worse*. A monthly-preferred window samples a tenor
that jumps — 42 DTE, then a 30–45 weekly once the monthly ages out — and IV term structure
turns that inconsistency into noise inside the 52-week range. "Nearest ≥ 28" is
tenor-stable, which is what a range wants.

### Decided: decouple (April)

The invariant is *"`currentIv` and the stored series must match each other."* Nothing
requires the **condor** to use that same expiration. So:

- IV rule **extracted verbatim, unchanged** → `IV_BASIS_CURRENT` stays `atm_28_52dte`,
  **zero recalibration owed**.
- Condor rule separate: 30–45 DTE, monthly preferred.
- **30–45 ⊂ 28–52, so both come from the SAME fetch** — the request parameters did not
  change at all, and no extra Schwab call was added.

Both orderings return **ordered lists**, not single picks, so the caller keeps v2.4's
fall-through past expirations left empty by the index root filter.

### The Schwab doctrine paying off again

**`expirationType` for a monthly is `"S"` (standard), NOT `"M"`.** Probe-pinned live across
SPY, GLD, TLT, XSP and SPX. Guessing "M" from the docs would have produced a preference
that *silently never fires* — indistinguishable from "no monthly is available". Read only
through `isMonthlyExpirationType`.

The SPX probe also re-confirmed v2.4's root filter: at 2026-09-18 the key carries
`roots: ["SPX","SPXW"]` with settlements `["A","P"]` on one expiration.

### Rules chosen

| | |
|---|---|
| Window | 30–45 DTE, **inclusive**; outside is EXCLUDED, not down-ranked |
| Monthly | **wins anywhere in range** — a 31-DTE monthly beats a 44-DTE weekly |
| No monthly | closest to the **37.5 midpoint** |
| Tie | breaks **LONGER** (35 vs 40 → 40) — must be deterministic, or the proposal wobbles between refreshes |
| Nothing in window | **refuse**, with the reason shown |

### Anti-conflation, enforced by the compiler

`ChainResult` lost its top-level `expiration`/`dte`/`calls`/`puts`. It now carries
`atmIv`/`ivExpiration`/`ivDte` plus a **nullable** `condor` block, so every call site must
say which tenor it means. `buildCondor` takes `CondorChain`, never the whole result.

**A null `condor` must not make `getOptionChain` return null** — the IV cron would skip
that symbol and punch an unrecoverable hole in its 52-week range (Schwab serves no
historical IV). The scanner refuses the card; the cron never notices.

The card now renders the refusal reason rather than silently omitting the trade block —
otherwise "outside the strategy's tenor" looks identical to "healthy", which is the same
silent state v2.6.1 and v2.9 were both about.

### Verified live (2026-08-07)

```
SPY   IV: 2026-09-04 (28 DTE)  |  CONDOR: 2026-09-18 (42 DTE)
GLD   IV: 2026-09-04 (28 DTE)  |  CONDOR: 2026-09-18 (42 DTE)
TLT   IV: 2026-09-04 (28 DTE)  |  CONDOR: 2026-09-18 (42 DTE)
XSP   IV: 2026-09-04 (28 DTE)  |  CONDOR: 2026-09-18 (42 DTE)
```

The IV pick deliberately still disagrees with the condor pick. **If those two ever
converge, the basis has silently changed** — `expiration.test.ts` has a suite pinning
exactly that.

### Consequence worth watching

Preferring monthlies **concentrates new positions on one expiration**. April already holds
SPY 9/18 and GLD 9/18. Schwab aggregates identical-strike positions, and both the Monitor's
GTC chip and the sweep's pre-place guard key on `underlying|expiration` — so a second Sep 18
condor in the same symbol reproduces the GLD situation resolved this morning, with its exit
needing manual placement. Flagged to April at decision time; accepted.

---

## 9. Open items

**Owed at today's sweep (Friday Aug 7, ~4:15 PM CT — the first live run for BOTH
milestones; they deployed together).** Every prediction below is falsifiable; a miss on
any of them is a real signal, not noise:

1. **One `sweep_runs` row written, and the dashboard banner renders it.** A blank banner
   would itself be the bug this milestone exists to fix — the failure state is an
   explicit red "could not load / has not run", never nothing.
2. **SPY 2026-09-11 gets a $2.74 GTC** (now `MATCH`, 35 DTE, `exitOrderId` null).
   **Absence is a signal.**
3. **GLD raises a `critical` flag** — trade B has no standing exit, and the pre-place
   guard sees trade A's `1007448830391` on the shared `underlying|expiration` key. This
   is *expected*, so the banner's first appearance will be red. It clears once trade B's
   GTC is placed by hand and `exit_order_id` backfilled.
4. **SPY 2026-08-28 is skipped entirely** — 21 DTE is below `PLACEMENT_MIN_DTE = 24`.
5. **The scanner proposes 2026-09-18 (42 DTE, monthly)**, not Sep 4. Verified against
   the live chain pre-deploy for SPY/GLD/TLT/XSP.
6. **IV Rank is UNAFFECTED** — `iv_history` still on basis `atm_28_52dte`, still counting
   toward 20 days (~Aug 27). **If IV Rank resets to 0, the two expiration selections
   merged** and the basis changed silently. This is the one to check hardest.
7. **The cron's snapshot log lines still read `@ 28 DTE`.** v2.10 changed that one
   expression from `chain.dte` to `chain.ivDte`, on a path that writes to `iv_history`
   every weekday.

**April's manual actions:**

8. **SPY 2026-08-28 butterfly** — 21 DTE as of today, no standing exit. Manual GTC at
   **$4.30**, or close. The sweep will not place it.
9. **GLD trade B** — place its 50% GTC by hand, then backfill `exit_order_id`.

**Carried:**

10. **Reconciliation still cannot see credit.** Legs and counts only; a trade journaled at
    the wrong credit remains invisible to everything. (Session 20 #8.)
11. **XSP place-and-cancel fixture** (v2.4 step 7) — unchanged.
12. **Board #17** — expiration date on the Monitor (Session 19). Note v2.10 makes this
    more useful: with monthlies preferred, most open trades will share an expiration.
13. **Monthly preference concentrates positions on one expiration.** Accepted at decision
    time, but it makes the Schwab same-strike aggregation problem more likely, not less.
    Worth revisiting if a second same-expiration collision appears.
14. **The DST margin returns in November.** The cron is 21:15 UTC — 4:15 PM CT now,
    3:15 PM CT in winter, i.e. 15 minutes after the close. Closed by April 2026-07-31 as
    "no change", and this session added a reason to keep an eye on it rather than reopen
    it: **observed Vercel Hobby drift is ~50 minutes** (22:05 UTC on Aug 5 and 6 against
    a 21:15 schedule). Drift *later* is harmless. Drift *earlier* in winter would not be.
    `sweepFreshness` now records every run's actual instant, so by November there will be
    real data instead of a guess.

---

## Pickup checklist

```
SteelEagle post-Session 21 (2026-08-07). BOTH MILESTONES SHIPPED:
  512952c  v2.9  sweep run visibility (migration applied in Neon and
                 verified; write path round-tripped against the live DB)
  fddc715  v2.10 expiration selection (30-45 DTE, monthly preferred)
602 tests · 1/2 cron slots · no pending migrations.

NEITHER HAS SURVIVED A LIVE CRON RUN. Both deployed together; the
Friday Aug 7 ~4:15 PM CT sweep is the first for each. Verify before
building anything on top of them.

v2.10 changed a line the IV cron writes from every weekday — chain.dte
became chain.ivDte. Confirm tonight's snapshot lines still read
"@ 28 DTE"; anything else means the two expiration selections merged.

STRUCTURAL RULE: LP < SP <= SC < LC. SP > SC is never valid.

FIRST, ask April — these are falsifiable predictions, check them:
- Did the dashboard banner render the sweep at all? A BLANK banner is the
  bug this milestone exists to fix; failure must render an explicit red
  "could not load / has not run", never nothing.
- Did SPY 2026-09-11 get its $2.74 GTC? Absence is a real signal.
- Did GLD raise a CRITICAL flag? It SHOULD — trade B has no standing exit
  and the pre-place guard sees trade A's 1007448830391 on the shared
  underlying|expiration key. Expected red, not a fault.
- Was GLD trade B's GTC placed by hand and exit_order_id backfilled?
- SPY 2026-08-28 butterfly (21 DTE Aug 7) — closed, or GTC at $4.30?
  The sweep will NOT place it; 21 DTE is below PLACEMENT_MIN_DTE = 24.
- v2.10: is the scanner proposing 2026-09-18 (42 DTE, monthly) now?
  IV Rank must be UNAFFECTED — iv_history still on basis atm_28_52dte,
  still ~Aug 27 to finish calibrating. If IV Rank reset, something
  merged the two selections.

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
- Diff a stored sweep report against a fresh one by serialized string.
  jsonb reorders keys on storage — compare structurally (deepStrictEqual).
- Merge orderIvCandidates and orderCondorCandidates. They agree only by
  coincidence of the window; merging silently changes IV_BASIS_CURRENT.
- Compare expirationType against "M". The monthly is "S" (probe-pinned).
- Make getOptionChain return null when no condor expiration qualifies —
  that drops the symbol from iv_history and holes its 52-week range.

Read first: lib/strategy/sweep-report.ts header, CLAUDE.md,
docs/steeleagle-session-20-summary.md §4a (its causal claim is CORRECTED
in §2 of this doc — Schwab rejected the order; the 24-DTE floor did not
prevent it).
```

---

## Closing note

Sessions 20 and 21 are the same lesson at two depths. Session 20 went looking for silent
states inside the app and found three. Session 21 found that the app's *loudest* channel
— a live-money cron flagging a mis-priced order — was itself silent, because nothing was
listening at the other end.

The pattern worth carrying: **a detector is only as good as its delivery, and "it fired
correctly" is not the same as "someone knows."** v2.6.1 fixed a badge that never
appeared. v2.8.1 fixed a check that could report "did not run" as "nothing found". v2.9
fixed a report with no reader. Three milestones, one shape.

Worth noting what did *not* change: the fix was observability, not control. Nothing in
the placement path learned to consult reconciliation, its history, or the banner.
Decision 5 held even after this session proved its stated rationale was partly wrong —
because the conclusion never depended on that rationale.

**v2.10 is a different lesson, and the sharper one for future sessions.** The request was
small — *"propose 30–45 DTE, prefer monthlies"* — and the honest implementation is about
ten lines. What made it non-trivial was invisible from the request: expiration choice and
IV measurement shared one code path, so the obvious edit would have silently reset 28
symbols' calibration and degraded the IV signal, with nothing failing and no test going
red. **The cost of the naive version was real and entirely off-screen.**

Three separate things pointed at it before any code was written: `iv-basis.ts` had left an
explicit warning for exactly this edit; `condor-builder.ts` carried a comment claiming a
30–45 window that had never existed; and the live probe said the monthly is `"S"`, not the
`"M"` any reasonable person would have written. **Every one of those was a note left by a
previous session, or a fact only the live API could supply.** None came from reading the
function being changed.

The habit that keeps paying: before changing a shared function, find out who else reads it
and what they are promised. Here two consumers wanted genuinely different things and had
been silently sharing an answer that happened to suit both. That coincidence was load-
bearing, undocumented at the call site, and one refactor away from a quiet data defect.
