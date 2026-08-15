# SteelEagle — Session 23 Summary

**Date:** August 14, 2026 (continuing after the Session 22 summary landed)
**Milestones:** **v2.11 fill ingestion** — SHIPPED end to end · **v2.12 quantity-aware guard
+ multiset reconciliation** — SHIPPED
**Branch:** main — `4eb7b9c` · `566ea2a` · `519f0f5` · `f03fce8` · `c2a638d` · `658a7c8` ·
`891a5fd` · `dce1472` — **all pushed**
**Test baseline:** 602 → **800 passing** · `tsc --noEmit` silent · build clean
**Migration:** `migrations/2026-08-14-fill-ledger.sql` — **applied in Neon and verified**
before the code that reads it was committed

---

## The shape of this session

Session 22 wrote the v2.11 spec. This session built all of it, then built v2.12 on top.

The through-line is unmissable in hindsight: **every single defect worth mentioning was found
by running the code against the live account, not by writing tests.** The tests were written
first and they all passed; they simply could not have known what Schwab actually returns.
Six real defects, all caught in the gap between "tests green" and "committed":

| # | Defect | Found by |
|---|---|---|
| 1 | `expiration` hydrated as a JS `Date` → `"Fri Sep 11"` | DB round-trip |
| 2 | Fractional equity quantity (`4167.68`) into an `integer` column | first ingestion |
| 3 | `pending: 122` — a count that was simply false | first ingestion |
| 4 | Zero-value executions made 13 dead orders read as FILLED | first match run |
| 5 | REJECTED orders offering "Journal this close" with blank prices | first prefill run |
| 6 | `held > covered` — right formula, wrong for a multi-lot trade | **the compiler** |

Only #6 came from a machine. The other five needed the real account.

---

## 1. v2.11 — shipped in five commits

| step | what | commit |
|---|---|---|
| 2–4 | golden fixtures · `position-delta` · `order-effects` · `balance` · `classify-fill` | `4eb7b9c` |
| 5 | migration + `lib/db/fills.ts` | `566ea2a` |
| 6 | cron wiring (report-only, isolated) | `519f0f5` |
| 7 | `match-fill` + Unjournaled Activity | `f03fce8` |
| — | instruction labels + one-click pre-fill | `c2a638d` |

### The headline proof

**The real Aug 14 SPY 09-11 split roll balances to exactly zero.**

```
delta:    735P −1 · 750P +2 · 765P −1     (call side correctly absent)
effects:  735P −1 · 750P +2 · 765P −1
residual: (empty) → BALANCED
```

Two `VERTICAL` tickets 4m28s apart say *nothing* about being a roll — in isolation they are an
independent close and an independent open. The identity holds anyway. That is April's Session
22 anchor proved on live data: **the interval is provably complete even where classification
is unsure.** Dropping either half leaves a residual naming exactly the legs the missing ticket
would have moved.

### The match is structural, not by order id

`trade_events.schwab_order_id` is only populated by the importer and the sweep. Everything
April types by hand — which is most of it — has it null. Matching on the id reported her whole
journaled history as unjournaled: that is what produced `pending: 122`.

The match instead asks: for each leg the fill touched, does a trade hold an event of the
corresponding TYPE at the same role/strike/expiration? A trade whose event set is a SUPERSET
has recorded it, whoever typed it.

**A pleasing consequence: the split roll needs no pairing step.** Its halves land on the same
event types a single-ticket roll produces, so a split roll journaled as ONE Roll form entry
matches BOTH tickets. That fell out of the correspondence rather than needing the heuristic
the spec worried about.

### Deviations from the spec, all deliberate

1. **`position_snapshots` stores the DERIVED symbol→qty map, not the raw array.** The map is
   the entire left side of the identity, and an object of integers has nowhere for an account
   identifier to hide. F4 established `accountNumber` is on every raw order body, and a
   stripping step is a thing that can be forgotten when a new field appears — containment by
   construction beats containment by discipline. Also ~1 KB/day instead of tens.
2. **`PARTIAL_OPEN` added to the shape set.** It was not in the spec and is required: it is one
   half of a split roll, and without it the Aug 14 open ticket had nowhere to land.
3. **`ACTIONABLE_WINDOW_DAYS = 7`** (§3 below).

---

## 2. The scope bound that made the inbox usable

Successive live runs reported **20, then 13, then 10** actionable fills — and every survivor
was a July artifact whose position no longer exists. The ledger holds 180 days; the inbox is
for THIS WEEK'S work.

> **A HISTORICAL BACKFILL IS A DIFFERENT EXERCISE from steady-state detection.** Older fills
> stay in the ledger — queryable, the forensic record v2.11 exists to create — they are simply
> not presented as tasks.

**Approved by April, 2026-08-14: seven days is acceptable.**

This does not lose the case v2.11 was built for. `reconcile.ts` is the authority on a journal
stale about a LIVE trade and says so as DRIFT or PHANTOM every run; the inbox is the
complementary half, not a second voice for the same finding. That is also why an owning open
trade no longer outranks expiry — an earlier draft had it, and it was the thing resurfacing
resolved history.

**Final live state: the inbox shows exactly FIVE items — the GLD rejection streak of Aug
10–13, and nothing else.** That is precisely the signal that ran eleven days unseen.

---

## 3. v2.12 — the first change to alter placement behaviour

### The guard

The defect: it refused to place when **any** working close existed on the key, so with two GLD
trades, A's GTC blocked B forever. But the hazard is **OVER-COVERING**; existence was only ever
a proxy.

```
place only when   held − covered >= contracts
```

`held > covered` was the first formulation and **the compiler caught it**: with held 2,
covered 1 and a 2-lot trade it is true, but placing would claim 3 of 2.

**Most of the design is the fail-safe.** Every unknown — `heldContracts` null, `contracts`
absent, `coveredContracts` null — degrades to the pre-v2.12 blanket rule, which is exactly
what shipped before and has never over-covered. `covered > held` is not merely blocked; it is
an anomaly nothing else would notice, and earns its own CRITICAL flag.

`held-contracts.ts` uses a uniform-magnitude rule, correct-then-conservative: 4 legs at `|2|`
→ 2 (the GLD fix); 8 legs at `|1|` → 1, which falls back to today's behaviour. Under-placing is
safe; over-covering is the hazard.

**Spec §6 decided: a THIRD isolated positions fetch** (option a). Coupling three independent
safety observations to one fetch is what the fail-safe reasoning argues against. Its failure
flags ROUTINE — the fallback is previously-shipped safe behaviour, but silently reverting a fix
looks identical to the fix working.

### The multiset

`reconcileJournal` returned `UNCOMPARABLE` the moment two trades shared a key. True that
attribution is impossible for fungible contracts — and the wrong question. **The union is
comparable even when the parts are not.**

Live, on the GLD pair that reported `UNCOMPARABLE ×2` for eleven days:

```
match 4 · drift 0 · phantom 0 · uncomparable 0 · unimported 0
```

Keyed on **`putCall`, not `role`** — an `OTHER` position carries the generic roles LONG/SHORT,
which lose put-vs-call entirely. **No partitioning:** splitting eight legs into two condors is
genuinely ambiguous, and a wrong pairing would build a wrong close. The union sidesteps the
question, which is also why `kind: 'OTHER'` stops mattering.

"Cannot tell" survives with three distinct causes, all pinned: an underivable peer structure
(the union is INCOMPLETE), missing per-leg quantities, and no position at all. `accountMultiset`
returns null rather than an empty map for the same reason `checkBalance` refuses a missing
anchor — empty-vs-empty compares equal and would manufacture a false clean bill.

---

## 4. v2.11 §8.1 discharged — `schwab_fill` closes are editable

**April, 2026-08-15 (CT evening of the 14th): widen it.**

**This was never hypothetical.** The v2.2 sweep has always written `schwab_fill` closes, and
the live journal holds **16 of them across four trades** — every one unrepairable except by
hand-written SQL, which is what the module exists to avoid.

The original refusal read *"that is Schwab's record of a real execution, not a typed number."*
Sound reasoning, conclusion too strong: `closeInputFromFilledExit` does not store Schwab's
record, it **derives** a quantity-weighted average from it — and this session established the
underlying data is not self-evidently clean (defects #2 and #4).

**Provenance is preserved, not erased.** Editing flips `source` to `'manual'` while KEEPING
`schwab_order_id`. The columns answer different questions — the order id says which fill the
leg came from, `source` says where the NUMBER came from. What stays immutable is event TYPE
and STRUCTURE, not provenance.

---

## 5. Corrections to the record

**C1 — the 714 test count was inflated.** Two test files imported fixtures from
`classify-fill.test.ts`, which re-registered its `describe` blocks in each importer and ran the
same assertions three times. Fixtures moved to `golden-fills.fixture.ts` (deliberately not a
`.test.ts`). The honest figure at that point was 677.

**C2 — v2.4 step 7 was already DONE, and April caught it.** Completed 2026-07-30: order
`1007409658003`, an unfillable XSP condor placed and cancelled in TOS, V7 answered,
`orderFixturePinned: true` shipped in `e3df1ff` with golden tests. Steps 8–10 landed with it.
The only open item is **step 11**, the manual ladder on the first qualifying XSP setup, which is
calendar-blocked on IV calibration finishing ~Aug 24–25 — not a build task.

This is the third time a stale queue entry has survived into a later session. **Check
`git log -- <file>` before believing one.**

Corroboration: order `1007409658003` was one of the 13 dead orders defect #4's fix stopped
reporting as work — it is that same unfillable probe.

---

## 6. Decisions locked this session

| # | Decision |
|---|---|
| D1 | **`ACTIONABLE_WINDOW_DAYS = 7`** (April). The inbox is for this week's work; a historical backfill is a different exercise. |
| D2 | **`position_snapshots` stores the derived map, not the raw positions array.** Containment by construction. |
| D3 | **Effects come from EXECUTIONS, never requested quantity** — which makes `orderEffect` status-independent with no status table to maintain. |
| D4 | **`UNRELIABLE` dominates `RESIDUAL`.** If our arithmetic is incomplete, the residual is evidence about us, not the account. |
| D5 | **Guard rule is `held − covered >= contracts`**, and every unknown degrades to the pre-v2.12 blanket rule. |
| D6 | **A third isolated positions fetch** rather than one hoisted shared fetch (spec §6a). |
| D7 | **Multiset keyed on `putCall`, never `role`; no partitioning.** |
| D8 | **Editing a `schwab_fill` close demotes `source` to `manual` and KEEPS `schwab_order_id`.** |
| D9 | **A pre-fill never fabricates a price** — empty string, never `"0.00"`. `$0.00` is legitimate for a worthless long, so a fabricated zero is indistinguishable from a real one. |

---

## 7. Owed / queued

- **v2.11 step 8 — gated auto-write. DEFERRED by April until the sweep has run.** §8.1 is
  discharged; the remaining gate is observational.
- **NOTHING FROM v2.11 OR v2.12 HAS BEEN THROUGH A REAL CRON RUN.** Everything was verified
  against live *data*, standalone. Specifically unexercised: the ingestion block inside the
  actual sweep, the first real balance check against the seeded anchor, and **the guard's new
  path**, which needs one GLD GTC to clear and re-place while the other stands.
- **v2.4 step 11** — manual XSP ladder, calendar-blocked to ~Aug 24–25.
- Board #17 · L3-in-app (Cancel GTC) · L3 ladder · L4 (next GTC fill).

### What to expect at the next sweep (~5:12 PM CT, Monday 2026-08-17)

| | |
|---|---|
| balance | `BALANCED`, empty residual — nothing traded over the weekend |
| ingestion flags | none, if balanced. **Silence is correct**: a zero residual is a proof, not an absence of complaints |
| inbox | the GLD rejections until they age past 7 days |
| guard | not exercised unless a GTC clears |
| reconciliation | `match 4`, no `UNCOMPARABLE` |

A BLANK Unjournaled Activity panel is the bug it exists to prevent — the clean state renders
an explicit dim line, and a failed check renders red.
