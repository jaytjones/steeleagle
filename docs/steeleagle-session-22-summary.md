# SteelEagle — Session 22 Summary

**Date:** August 14, 2026
**Milestones:** none shipped — **v2.11 spec** (fill ingestion) + tooling. No app code changed.
**Branch:** main — `a058f36` (v2.11 spec + `dump-filled-orders.ts`) · `c1f9a60`
(`export-journal.ts`) — **both pushed**
**Test baseline:** **602 passing** (unchanged — no `lib/` modules added) · `tsc --noEmit`
silent · build clean
**Migration:** none. Two tables are *specified* (`position_snapshots`, `schwab_fills`) and
**not yet written**.

---

## The shape of this session

April opened with a process question, not a bug: *the strategy requires placing trades
outside the tool, so most trades have to be hand-journaled — how do we make the journal
detect them automatically?*

The answer turned out to be that **the account already carries everything except intent**,
and the app has been reading the wrong half of it for four milestones. Chasing that produced
a spec, a fixture dump that overturned an assumption before any code was written, and — as a
side effect — the discovery of an **11-day silent failure** nobody had seen.

Then April rejected two of the three things proposed, and the rejections produced a better
design than the original.

---

## 1. The gap — positions are a snapshot, a roll is a transition

Every automatic-detection path derives account truth from **positions**:

| Event | Fallback | Derives from | Gap |
|---|---|---|---|
| OPEN | Import from Schwab (manual trigger) | positions, enriched by filled orders | dedupes on `underlying+expiration` |
| CLOSE | sweep reconcile | **only** orders already in `trades.exit_order_id` | a TOS close is invisible |
| ROLL | none | — | — |

`lib/journal/reconcile.ts` header states the governing constraint: *"the ACCOUNT is truth for
STRUCTURE, but the JOURNAL is the only record of PRICES and INTENT."*

> **That is true of positions and FALSE of orders.**
> `orderActivityCollection[].executionLegs[]` carries real per-leg fill price, quantity and
> time. The repo already proves it twice — `importer.ts:215-238` for opens,
> `close-from-fill.ts:78-89` for closes. Only INTENT (`closeReason`, `notes`, `initialBpr`)
> is genuinely unrecoverable, and that is small and askable.

**The leverage:** `getWorkingAndRecentOrders(hash, 180)` already runs once per sweep with no
status filter (`snapshot-iv/route.ts:260`), and `getAccountSnapshot()` at line 281 already
fetches raw positions. Both are discarded every run. **No new API call is required.**

---

## 2. April's anchor — the accounting identity (2026-08-14)

The original proposal was order-stream classification. April's counter:

> *"Can't we use a snapshot of the positions at a point in time, and then review any orders
> that were placed since then as a point of comparison?"*

This is strictly stronger, and it was adopted:

```
positions(T₀)  +  Σ order effects in (T₀, T₁]  ==  positions(T₁)
```

Balancing is a **completeness proof**, not a confidence score. A pure classifier has a
silent-miss mode (order outside the window, unparseable, dismissed) with nothing to detect
it. Three consequences:

1. **The residual is the valuable part.** A non-zero residual is exactly the class of events
   that produce *no order at all* — expirations, assignments, exercises. Detectable without
   touching `/transactions` and without a new fixture.
2. **It makes the aggregation problem tractable.** `reconcile.ts:330-335` documents two
   1-lot condors as indistinguishable from one 2-lot. True of a snapshot, false of a delta:
   0→1 one day and 1→2 another, each step with its own timestamp and order id. Resolves
   **detection**, not **representation** — prospectively only.
3. **It handles the split roll natively** (see §3), which is the case classification alone
   struggles with.

**Diff at the OCC-symbol level, never the condor level.** `groupIntoCondors` bails to
`incomplete` on anything non-textbook; a map diff has no such failure mode. The diff layer
must be *dumber* than the grouping layer, and therefore more reliable.

---

## 3. Doctrine section — the fixture dump

`scripts/dump-filled-orders.ts` (new, read-only) is the counterpart to
`dump-working-orders.ts`, which deliberately filters FILLED orders **out**. Pulled 14 days:
54 orders / 19 FILLED / 11 with option legs. **Four findings, none derivable from the docs.**

### F1 — Rolls are single mixed tickets. Usually.

Six historical rolls, all one ticket with mixed `_TO_OPEN` / `_TO_CLOSE` legs:

| orderId | date | underlying | closed → opened |
|---|---|---|---|
| 1007450735138 | 08-04 | SPY 08-28 | 680/700P → 720/740P |
| 1007454721397 | 08-04 | SPY 09-11 | 700/715P → 725/740P |
| 1007465290239 | 08-04 | SPY 08-28 | 720/740P → 745/765P |
| 1007483420023 | 08-05 | SPY 09-11 | 725/740P → 735/750P |
| 1007511371504 | 08-07 | GLD 09-18 ×2 | 330/350P → 365/385P |
| 1007598809028 | 08-14 | GLD 09-18 ×2 | 365/385P → 375/395P |

Single-ticket rolls make ROLL detection **exact**. **But a SPLIT roll happened the same day:**
SPY 09-11 rolled as two `VERTICAL` tickets 4m28s apart — `1007598808689` (ALL_CLOSE, BTC 750P
@3.14 / STC 735P @1.89) and `1007598809002` (ALL_OPEN, STO 765P @5.60 / BTO 750P @3.12).
Both forms are real; the split case must be **refusable**.

### F2 — `complexOrderStrategyType` is UNUSABLE for classification

| shape | observed |
|---|---|
| 4-leg entry | `IRON_CONDOR` |
| 4-leg close | `IRON_CONDOR` |
| 2-leg vertical | `VERTICAL` |
| **4-leg roll** | **`CONDOR` ×5, `CUSTOM` ×1** |

`1007483420023` (`CUSTOM`) and `1007454721397` (`CONDOR`) are structurally identical SPY 09-11
four-leg put rolls. Schwab labelled them differently. **Classify from `instruction` alone.**
Same trap class as `settlementType` meaning AM/PM. Does not affect the outbound builders,
which correctly hardcode `IRON_CONDOR` for their own tickets.

### F3 — `legRole` must NOT be reused for rolls

`close-from-fill.ts:31-36` uses `short = instruction.startsWith('BUY')` — correct for a pure
close, **wrong for a roll**, where `BUY_TO_OPEN` is a long.

| instruction | side | journal event |
|---|---|---|
| `BUY_TO_CLOSE` | was SHORT | `roll_close` |
| `SELL_TO_CLOSE` | was LONG | `roll_close` |
| `SELL_TO_OPEN` | becomes SHORT | `roll_open` |
| `BUY_TO_OPEN` | becomes LONG | `roll_open` |

### F4 — `accountNumber` is in every raw order body

Six occurrences in a 14-day window. `dump-order.ts`'s warning ("the order body itself carries
no account hash, but check for an `accountNumber` field") **understates it**. `schwab_fills`
must strip it at the ingestion boundary, not at render.

---

## 4. What the dump found live — an 11-day silent failure

Standing-order check found **exactly one WORKING order**, and it was healthy
(`1007557518040`, SPY 09-18 710/735/800/825 @2.58). But the terminal history showed GLD's
exit GTC **REJECTED every night since Aug 3** — Aug 10, 11 ×2, 12 ×2, 13 ×2 — always on the
original `400C/420C/350P/330P`. The put side had been rolled twice; the journal never learned;
the sweep rebuilt a close on legs not held; Schwab bounced it. Every night.

`sweep_runs` recorded all of it faithfully (§7 C3). Nothing else surfaced it.

Morning reconciliation also showed **2 criticals**: `DRIFT` on SPY 09-11 (today's split roll)
and `PHANTOM` on SPY 08-28 (closed in TOS Aug 7 via `1007514529392`, never journaled).

**April journaled all of it during the session.** End state — **0 critical**:

```
match 2 · drift 0 · phantom 0 · uncomparable 2 · unimported 0
```

The 2 remaining `UNCOMPARABLE` are the GLD shared-key limitation, not a fault.

---

## 5. `scripts/export-journal.ts` — restore point

Read-only SELECTs to a timestamped JSON file. The journal is the only irreplaceable copy:
the account can always be re-read from Schwab, but nothing can reconstruct what a leg filled
at or why a trade was closed.

Two decisions worth keeping:

- **Rows are serialized server-side with `to_jsonb(t)`.** node-postgres hydrates a `date`
  column into a JS `Date`, which `JSON.stringify` renders as a full ISO timestamp —
  `current_expiration` would export as `"2026-09-18T00:00:00.000Z"` and restore as a
  **different day** in any timezone west of UTC. Verified live: `to_jsonb` emits
  `"2026-07-17"`. It is also `select *` that survives schema change.
- **The file is re-read and `deepStrictEqual`-compared before exit.** An unverified backup is
  one you find out about during the restore.

Excluded and loud about it: `iv_history` (opt in with `--with-iv` — **no backfill**),
`tokens`/`accounts` (secrets), `sweep_runs`. `backups/` is gitignored.

First run: 15 trades (5 open / 10 closed), 120 events, 78.7 KiB, verified.

---

## 6. The shared-key question — two rejections and what replaced them

April: *can two separate trades be grouped as one, or how do we address the
`underlying|expiration` limitation more cleanly?*

**Proposed and REJECTED — merge into one trade.** Not representable anyway:
`currentStructure` hard-refuses anything but exactly four `open` events, one per role
(`opens.length !== 4` → throw; duplicate leg → throw). Eight open events yields *no* GTC
rather than one. Any grouping concept would have to sit above or inside the one predicate
CLAUDE.md insists stay shared.

**Proposed and REJECTED by April — refuse a second trade at entry.**

> *"I don't like the idea of refusing at entry — sometimes it's a valid trade that should be
> placed with an acceptable setup."* — April, 2026-08-14

Correct, and it exposed that merging solved the wrong problem.

### What replaced both — the defect is the GUARD, not the model

The pre-place guard refuses when **any** working close exists on the same
`underlying|expiration`. But the hazard it exists to prevent is **over-covering**. The correct
rule is quantity-aware:

> place only if `held contracts > contracts already covered by working close orders on
> matching legs`

GLD: 2 held, 1 covered → trade B's GTC places automatically. Single 1-lot trade with a
standing GTC: 1 held, 1 covered → still blocked, exactly as today. One rule, both cases, and
it falls out correctly for distinct strikes too.

And **reconcile should compare leg multisets**, not attribute one position to one trade.
Union of all journal trades on a key vs the account's flat legs as a multiset of
`(role, strike, expiration, qty)`. Identical strikes → MATCH; distinct strikes → both
verified. **No partitioning heuristic** — splitting 8 legs into two condors is genuinely
ambiguous (330L/350S + 365L/385S vs 330L/385S + 365L/350S) and a wrong pairing builds a wrong
close. Multiset comparison sidesteps the question instead of guessing.

**These are the first changes in this thread that alter placement behavior** — everything
else is report-only. The guard change *loosens* a safety check, so it must be pure-with-tests
first and reviewed specifically against the over-cover case.

Filed as **v2.12**, separate from v2.11 so the two ship independently.

---

## 7. Corrections to the record

**C1 — The cron's OBSERVED firing time is ~22:12 UTC (≈5:12 PM CT), not 21:15 (4:15 PM CT).**
`sweep_runs` shows Aug 11, 12 and 13 all at 22:12, within 2 seconds of each other. The
*schedule* is `15 21 * * 1-5` and is correct; Vercel Hobby drift has stabilized at ~57 min
(CLAUDE.md records ~50 min from Aug 4–6). This is a refinement, not a doc error — but "4:15
PM CT" is the schedule, not when it runs. `sweepFreshness`'s 2-missed-run tolerance exists
for exactly this and is unaffected.

**C2 — The fungibility argument was overreached.** It was claimed that no rule can say which
trade closed when one of two identical lots exits. True of *contracts*, false of *orders*:
each trade's GTC has its own order id and the sweep attributes fills by `exit_order_id`.
Contracts are fungible; orders are not. This removes the argument for merging.

**C3 — v2.9's owed first-live-run verification is DISCHARGED.** CLAUDE.md still lists it as
owed at the Aug 7 sweep. `sweep_runs` rows exist for Aug 11/12/13 with `severity`, `headline`
and per-flag `severity` all populated, and the Aug 11 run shows a real placement
(`placed: SPY @2.58, order 1007557518040`). It also captured the GLD rejection streak
faithfully — two criticals a night. **Update the CLAUDE.md "Verification owed" line.**

---

## 8. Decisions locked this session

| # | Decision |
|---|---|
| D1 | **Snapshot-anchored accounting identity** is the detection mechanism (April). Balance check = completeness proof; residual = the no-order event class. |
| D2 | **Delivery is inbox-first.** When auto-write is eventually enabled it is gated on the interval **balancing to zero residual**, never on classifier confidence. If anything in a day is unexplained, everything from that day goes to the inbox. |
| D3 | **Classify fills from `instruction` alone.** `complexOrderStrategyType` is never read (F2). |
| D4 | **No refusal at entry** (April). A second trade on an occupied `underlying\|expiration` is a legitimate trade and must never be blocked. |
| D5 | **No merging of same-key trades.** Two trades stay two trades, each with its own credit, target and GTC. |
| D6 | **v2.12 = quantity-aware pre-place guard + multiset reconcile**, specced separately from v2.11. |
| D7 | `position_snapshots` and `schwab_fills` mirror `sweep_runs`: **write-only from the cron, read-only everywhere else. Nothing in the placement path may read either.** |

---

## 9. Queued / owed

- **v2.11 build order steps 2–4** — pin the six roll payloads + the split-roll pair as golden
  fixtures; then `position-delta.ts` · `order-effects.ts` · `balance.ts`; then
  `classify-fill.ts`. All pure, tests first, placement path untouched.
- **v2.12 spec** — not yet written (§6).
- **Open decision (v2.11 §8.1):** an auto-written close would be **uneditable** —
  `edit-close.ts` only repairs `close` events with `source: 'manual'`. Needs a call before
  any auto-write.
- **The GLD evidence sharpens v2.11's scope:** the inbox should surface **rejected sweep
  placements**, not only unjournaled fills. A GTC Schwab bounces on the same legs every night
  is the strongest available signal that the journal has drifted, and today it is visible
  nowhere in the app.
- **v2.4 step 7** (XSP place-and-cancel fixture — April, manual) · Board #17.
- **Watch the next sweep:** neither GLD trade has a standing GTC, so the planner should queue
  both from one fetch and both should place (6.82 and 5.11) — correct coverage at 2 held / 2
  covered. If so, the guard limitation is narrower than stated: it bites only once *one* of
  the pair is standing, which is the steady state from the following run onward.

---

## 10. Gates

```
npx tsx --test "lib/**/*.test.ts"     602 passing
./node_modules/.bin/tsc --noEmit      silent
rm -rf .next && npm run build         clean
find … -name "* 2.*"                  clean
```

No migration pending. No `lib/` or `app/` file was modified this session — the two commits
add one doc and two standalone scripts, so the deploy is behaviourally a no-op.
