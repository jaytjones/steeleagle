# SteelEagle — Session 26 Summary

**Date:** August 20, 2026 (evening — Session 25 was the same day, morning)
**Milestone:** **the gate opened**, and then **v2.13.2 — Schwab files a CANCELLATION as an EXECUTION.**
**Branch:** main
**Test baseline:** 828 → **848 passing** · `tsc --noEmit` silent · build clean
**Migrations:** none. Nothing in this session changed a table.

---

## The shape of this session

Session 25 owed exactly one thing: *one real cron run reporting `balance: BALANCED`.*
This session opened by checking whether it had happened.

**It had.** And then the same check found the next reason it should not be trusted yet.

```
Thu Aug 20, 4:27 PM CT   severity=warning  crit=0 warn=1
  ingestion.ran=true   anchor Aug 19 4:34 PM -> snapshot Aug 20 4:27 PM
  BALANCE: BALANCED    residual: (empty)
  reconciliation: match 3 · drift 0 · phantom 0 · uncomparable 0 · unimported 0
  FLAG [routine] INGESTION — 4 recent fill(s) need journaling or review.
```

Every line of Session 25's prediction table came true. The `UNRELIABLE` critical is gone.
The self-resolving PHANTOM did not recur — the SPY 09-18 trade is closed, so nothing read
it as open. The only flag is the routine one, which is what a healthy night looks like.

**D4 is satisfied and v2.11 step 8 is unblocked.**

### Two qualifications, both worth holding onto

**Q1 — the proof was TRIVIAL.** Nothing traded between Aug 19 and Aug 20, so both sides of
the interval were empty. Empty minus empty is zero. That genuinely proves something — the
pass runs to completion with **no refusals**, which is precisely what v2.13.1 fixed and
what had never once been true in production — but it does not exercise the identity
against real movement. **A non-trivial live BALANCED is still owed.**

**Q2 — the drift figure moved again.** Aug 20 landed at **21:27 UTC ≈ 4:27 PM CT**, about
12 minutes. Aug 18 and Aug 19 were both 21:34 (19 min); Aug 11–13 were all 22:12 (57 min).
Session 25's C1 said drift is stable *within* a stretch and re-baselines *between* them;
three stretches in, even the within-stretch stability is loose. **Quote the DUE time
(21:15 UTC). When telling JJ when to look, quote the most recent observed run.**

---

## 1. v2.13.2 — the cancellation that Schwab records as an execution

With the gate open, the next question was what the inbox actually held. Two actionable
items. The first did not survive a look:

```
1007540494945  UNJOURNALED_CLOSE  trade=7dc07054
  SPY 2026-09-11  Aug 14, 10:57 AM CT  status=CANCELED contracts=0 net=2.74
  "Closed at Schwab but the journal still lists this trade as OPEN. Record the close."
```

A **CANCELED** order with **`contracts: 0`**, telling JJ to record a close. The live order:

```
status:          "CANCELED"
filledQuantity:  0
orderActivityCollection: [{
  activityType:  "EXECUTION",         <- the same word a real fill uses
  executionType: "CANCELED",          <- the ONLY field that says what this is
  executionLegs: [ {legId:1, quantity:1, price:0}, ... x4 ]
}]
```

This is the sweep's own SPY 2026-09-11 exit GTC, placed Aug 10 at 2.74, which JJ cancelled
in TOS on Aug 14 to roll the position instead. Nothing traded. **Four legs at quantity 1
say otherwise to anything that reads `executionLegs` alone** — and nothing in the codebase
read `executionType`. It was not even a field on `SchwabOrderActivity`.

### The two live consequences

**(1) The identity.** `orderEffect` signed all four legs, inventing a complete condor close
that never happened:

```
orderEffect over an interval containing the CANCEL:
  SPY 260911C00775000 +1   C00790000 -1   P00750000 +1   P00735000 -1
```

**44 such records stood in the live 180-day window**, and there will always be more.

**The worst case is REPLACED, not CANCELED.** A replaced order's cancel record repeats the
very legs its replacement then fills, so the phantom does not look like noise — it
**doubles** real movement. Replayed over the Aug 14 split-roll morning:

| | GLD 395/385/375/365 | SPY legs |
|---|---|---|
| what traded | ∓2 / ±2 | 3 legs |
| what the identity read | **∓4 / ±4** | **5 legs** |

A residual that says the account moved twice as much as the journal does, with nothing in
it pointing at the cause.

**(2) The inbox.** `classifyFill` reported `filled: true`, shape `CONDOR_CLOSE`, and
`matchFill` — whose `!fill.filled → NOT_ACTIONABLE` gate was correct all along — was handed
a lie. The trade it proposed closing, `7dc07054`, is open at Schwab right now; the
reconciler reports it `MATCH` at 750/765/775/790. Journaling that close would have marked a
live position closed and **stopped the sweep managing it**. Note that the cancelled GTC
names 735/750/775/790 — the *pre-roll* strikes. It was cancelled *because* the roll moved
them.

**44 of the 111 ledger rows carried a false `filled: true`.**

### Why it hid

It needs a cancellation **inside a snapshot interval**. The fill ledger was anchored
2026-08-14 at 10:22 PM CT, and that day's last cancel was 11:04 AM — eleven hours earlier.
All three stored intervals missed it, **including this morning's first-ever BALANCED run**.

### Why the existing guard did not catch it

Session 22 met this exact class and guarded it in `classify-fill.ts` with *skip
zero-quantity executions*, written against three orders (1007449913576 REPLACED,
1007448830387 and 1007468901534 CANCELED) whose cancel records carried quantity 0.

**That premise does not hold.** All 44 cancel records live on 2026-08-20 carry a
**non-zero** leg quantity — 1, 2 or 5. Price is not a discriminator either: a real fill may
legitimately print 0, and the importer already depends on that being possible.
`executionType` is the only field that says what the record IS.

### The scan the fix is built on

Per the Schwab doctrine, the polarity was chosen from a live scan, not from the docs. Every
activity in the 180-day window on 2026-08-20 — 100 records across 123 orders:

| n | status | activityType | executionType | leg quantity | leg price |
|---|---|---|---|---|---|
| 56 | FILLED | EXECUTION | **FILL** | real | real |
| 22 | CANCELED | EXECUTION | **CANCELED** | 1, 2 | 0 |
| 22 | REPLACED | EXECUTION | **CANCELED** | 1, 2, 5 | 0 |

`executionType` was present on all 100. REJECTED, EXPIRED and PENDING_ACTIVATION carry **no
activity collection at all** — which is why a rejected order was always harmless, and why
the header's claim that reading executions is *"status-independent"* survived as long as it
did. It is true of a rejection and false of a cancellation.

### The fix — one predicate, three values

`lib/schwab/executions.ts`, `executionScope(activity)`:

| | meaning | `orderEffect` (a PROOF) | classification / price paths (a PROPOSAL) |
|---|---|---|---|
| `FILL` | contracts moved | sign it | read it |
| `NONE` | cancel or replace — **known zero** | contribute zero, **no refusal** | skip it |
| `UNKNOWN` | absent or unrecognised label | **REFUSE** | read it, unchanged |

The two callers deliberately disagree about `UNKNOWN`, and that is the point. The identity
is a completeness proof and cannot afford a maybe, so an unrecognised label makes the
interval `UNRELIABLE` — the honest state for *"I cannot tell what this record was"*, and
the guard against a future Schwab label silently **deleting** real contracts. The
classification and price paths are building a proposal for JJ behind their own
refuse-don't-guess gates, and read on exactly as before.

A cancellation is a **KNOWN ZERO in both**, never a refusal. Refusing there would be the
SWVXX failure of twelve hours earlier in a new costume (D2).

### Also guarded, same root cause

- **`lastExecutionTime`** (order-effects) — an interval must be bound by the moment
  contracts moved, not by the moment a GTC was killed.
- **`classifyFill`'s `occurredAt`** — same reason, and the **7-day actionable window reads
  that field**, so a long-dead GTC looked like activity from its cancellation day.
- **`close-from-fill`'s weighted average** — a `price: 0` leg drags a close price toward
  zero, and that price gets journaled.
- **`importer`'s last-fill-wins** — a cancellation's zero-price legs would *overwrite* real
  prices recorded before them.

### Verified live before shipping (read-only)

```
identity, all four stored intervals, fixed code:
  Aug 14 10:22 PM -> Aug 18 4:34 PM   BALANCED   (empty)
  Aug 18  4:34 PM -> Aug 19 4:34 PM   BALANCED   (empty)   order 1007557518040 moved contracts
  Aug 19  4:34 PM -> Aug 20 4:27 PM   BALANCED   (empty)
  Aug 20  4:27 PM -> live now         BALANCED   (empty)

split-roll morning replay (Aug 13 11:00 PM -> Aug 14 10:22 PM CT):
  before: GLD ±4, 5 SPY legs, 6 contributing orders
  after:  GLD ±2, 3 SPY legs, 3 contributing orders   <- what actually traded

what the NEXT cron run will write:
  44 of 111 ledger rows flip `filled` true -> false
  NOT_ACTIONABLE 9 -> 53
  actionable inbox 2 -> 1  (the survivor is the genuine REJECTED_PLACEMENT drift signal)

reconcile-journal: match 3 · drift 0 · phantom 0 · uncomparable 0 · unimported 0 · exit 0
```

The ledger heals itself: `upsertFills` overwrites `filled` and `classification` from
`EXCLUDED` on every run and re-ingests the whole window, while leaving `disposition` and
`trade_id` — JJ's judgement — untouched. **No migration, no backfill, no manual repair.**

`SPY_CANCELED_GTC` pinned from order 1007540494945. The eight existing golden fixtures now
carry the `executionType: 'FILL'` the original trim had dropped.

---

## 2. Corrections to the record

**C1 — "reading executions makes this module STATUS-INDEPENDENT" was false.** It is the
sentence in `order-effects.ts` that made the defect invisible, and it is half-true in the
same shape as v2.13.1's *"their effects are already nil"*: true of a REJECTED order (no
activity collection), false of a CANCELED or REPLACED one. **Two consecutive defects have
now been protected by a confident comment stating the opposite of the truth.** When a
header explains why a whole class of input is harmless, that is the thing to go and check
against a live payload.

**C2 — Session 22's zero-quantity guard is not coverage for cancellations.** It still
earns its place (a missing quantity must count as zero, not one), but it is belt-and-braces
now, not the guard. Its comment said cancel records carry `price: 0` across every leg,
which is true and is not sufficient.

**C3 — an inbox item is a PROPOSAL, and this one was wrong in the most dangerous
direction.** v2.11 bounded the inbox to avoid the wallpaper hazard — an inbox that is
always full stops being read. This is the opposite failure: a **short, credible** inbox
containing an item that would have destroyed live state if actioned. Both v2.9 and v2.11
legislated against noise; nothing yet legislates against a confident false positive, and
the only thing that caught this one was reading the underlying order.

---

## 3. Decisions locked this session

| # | Decision |
|---|---|
| D1 | **`executionType` is the discriminator for whether contracts moved.** Not status, not quantity, not price. One predicate — `executionScope` — and every consumer of `orderActivityCollection` goes through it. |
| D2 | **A cancellation is a KNOWN ZERO, not a refusal.** Present, in scope, and definitively moved nothing — the same shape as a non-OPTION leg, for the same reason (Session 25 D2 continues to hold in both directions). |
| D3 | **An UNRECOGNISED or ABSENT `executionType` REFUSES in the identity, and is read unchanged in the proposal paths.** The proof cannot afford a maybe; the proposal paths already have their own gates. The two callers disagreeing is deliberate. |
| D4 | **A trivial BALANCED (both sides empty) is not the same evidence as a BALANCED over real movement.** Both are recorded; the second is still owed. |

---

## 4. Owed / queued

- **OWED — a NON-TRIVIAL live `BALANCED`**: one cron run whose interval contains a real
  fill. After today, the interval most worth watching is one containing a **cancelled
  GTC**, which is the case that was structurally broken until this session.
- **v2.11 step 8 — gated auto-write. UNBLOCKED**, and now waiting on **JJ's scope
  decision**, not on an observation. §8.1 was discharged by v2.12 (`dce1472`). The open
  scope questions, in the spec's own terms:
  - §8.2 — an OPEN can never be fully hands-off (`initialBpr` is not in the order payload,
    and `enteredBpr` refuses 0 by design). Import remains its path.
  - §8.3 — ROLL pairing across a split ticket needs a window rule (proposed: same
    underlying and expiration, overlapping symbols, within 15 minutes, **exactly one**
    candidate on each side, else `AMBIGUOUS`). Today's live example was 4m28s.
  - CLOSES are the safe case, and the sweep already auto-journals the ones it placed
    itself (L4). Step 8's real addition is closes JJ did **in TOS**.
- **OPEN QUESTION for JJ — the self-resolving PHANTOM.** Carried from Session 25 and
  **still unfixed by decision**. It did not fire on Aug 20 because the trade is closed, not
  because anything changed. It will recur the next time the sweep journals a close.
- **v2.4 step 11** — manual XSP ladder. IV calibration completes ~Aug 24–25.
- L3-in-app (Cancel GTC) · L3 ladder.
- `trades` key sites (b) and (c) — open by decision.

### What to expect at the next sweep (Fri Aug 21, ~4:30 PM CT on current drift)

| | |
|---|---|
| auth | fine — deadline **Tue Aug 25, 10:10 AM CT**. Re-login is due early next week |
| ledger | **44 rows flip to `filled: false`** as the window is re-ingested |
| inbox | **2 → 1**. The false SPY 09-11 close disappears; the REJECTED_PLACEMENT drift signal stays |
| balance | `BALANCED`, residual empty — still trivial unless something trades |
| reconciliation | `match 3`, unchanged |
| guard | still not exercised; it needs a GTC to clear and re-place while another stands |
