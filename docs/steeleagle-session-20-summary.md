# SteelEagle — Session 20 Summary

**Date:** August 4, 2026 (evening session)
**Milestones:** **v2.7** iron butterfly recognition · **v2.7.1** butterfly exit gate discharged ·
**v2.8** journal ⇄ account reconciliation · **v2.8.1** reconciliation wired into the cron
**Branch:** main — `d43be78`, `e2e15a7`, `9f91aed`, `74c38cb`, `03671e3`, `852c21f`, all **pushed**
**Test baseline:** 489 → **534 passing** (+45) · `tsc --noEmit` silent throughout

---

## The shape of this session

It began as a one-line structural change — *let iron butterflies count as iron condors* — and
ended having found **three separate bookkeeping faults on three of the four open trades**, none
of which the app could detect. The milestone that shipped first (v2.7) turned out to be the
smallest thing that happened.

The through-line: **every silent state we went looking for was real.**

---

## 1. v2.7 — iron butterfly recognition

April: *"An Iron Butterfly is a special case of an iron condor, but our logic currently mandates
LP < SP < SC < LC."* Clarified mid-session: *"Iron butterflies should only occur because of
rolls. The scanner shouldn't create butterflies. But the positions monitor should still be able
to recognize them as a type of condor."* And then, decisively: **`SP` should NEVER be greater
than `SC` — `LP < SP <= SC < LC`.**

That invariant is now the repo-wide rule. The `<=` admits the butterfly's zero-width body; a
crossed body is refused everywhere.

The constraint lived in exactly five places, in two risk tiers that got opposite treatment:

| Site | Tier | Outcome |
|---|---|---|
| `reconstruct-positions.ts` `noOverlap` | recognition | relaxed to `<=` |
| `importer.ts` `groupIntoCondors` | recognition | relaxed to `<=` |
| `current-structure.ts` | order path | **new** ordering check (see §2) |
| `exit-ticket.ts` | order path | gate, then discharged in v2.7.1 |
| `order-ticket.ts` | order path | **still refuses** |

**A butterfly is an `IRON_CONDOR`, not a new `PositionKind`.** Same four roles, same wings, same
`wingWidth − credit`. That is safe because every role assignment in the codebase already keys on
**PUT vs CALL, never on strike** — equal strikes only ever broke the *ordering assertions*, not
leg *identification*.

**What the `<` was silently costing:** a butterfly fell to `OTHER` on the Monitor, losing BPR,
DTE, roll verdicts, the journal-exit chip — **and a slot in the 5-position cap.** The
position-limit gate was under-counting a real, fully-collateralized trade.

Untouched by design: `buildCondor` targets 16Δ shorts and a butterfly's are ~50Δ, so the scanner
cannot produce one; `PlaceOrderPanel` stays strict.

---

## 2. The defect v2.7 surfaced — a green chip over a permanently failing placement

`currentStructure` **compared no strikes at all.** `isPriceableStructure` is the ONE predicate
the sweep planner and the Monitor's `MANUAL GTC` chip both consume, so *any* mis-ordered
structure passed it:

> Monitor renders a green GTC-target chip → planner queues the trade → `buildCondorExitTicket`
> throws inside the placement loop → `report.errors` **every sweep run, forever**, no exit ever
> placed, UI claiming it was covered.

This was live before Session 20 and is independent of butterflies. Moving the ordering check
into the predicate routes it to `plan.toFlag` with the refusal verbatim — the designed fail-safe.

**Three existing test fixtures had been leaning on the gap** and had read as "passing" for 20
sessions while describing structures that could never be priced: two rolled a short put onto the
700 long put (zero-width spread), one rolled a short call to 800, above the 790 long call
(crossed). All three would have thrown at the builder. Strikes corrected; fold semantics
unchanged.

---

## 3. v2.7.1 — the fixture, and what it answered

April placed an unfillable GTC butterfly close the same evening. Dumped with the new
`scripts/dump-order.ts` (read-only `GET /accounts/{hash}/orders/{orderId}`; preferred over
`dump-working-orders.ts` whenever the id is known).

**orderId 1007469542479** — SPY 2026-08-28, LP 745 / SP 765 / SC 765 / LC 785, qty 1 @ 0.05.

> **`complexOrderStrategyType: "IRON_CONDOR"`.** Schwab records an iron butterfly **identically
> to a condor** — same envelope, same SC/LC/SP/LP leg order. There is no distinct butterfly type.

Pinned as `SPY_BUTTERFLY_GOLDEN` in `exit-ticket.test.ts`. The exit gate came off.

**The entry gate did not, and must not.** Two independent grounds: the fixture is a **CLOSE**
(`NET_DEBIT` / `*_TO_CLOSE`), so the entry payload is still unpinned; and the app must never
*open* a butterfly. `order-ticket.test.ts` pins that asymmetry with a test that says in as many
words not to "fix" it by loosening the assertion.

---

## 4. The three faults found along the way

### 4a. SPY 2026-08-28 — an unjournaled roll (CRITICAL, near-miss)

The fixture's strikes didn't match the journal. Cross-checking Schwab positions against
`listTrades` showed the account held the butterfly (745/765/765/785) while the journal still read
720/740/765/785. April confirmed: **two rolls, the second never journaled.**

The sweep builds close orders **from the journal**. A placement would have carried
`BUY_TO_CLOSE 740P` / `SELL_TO_CLOSE 720P` — legs not held. **Those close nothing; they OPEN a
short put spread.**

It did not place. Verified: `exitOrderId=null`, nothing standing on those legs. **What prevented
it was `PLACEMENT_MIN_DTE = 24` with the trade at exactly 24 DTE, dropping to 23 the next day —
the calendar, not a guard.** Had the roll been journaled a day earlier, the sweep would have
placed a correct butterfly GTC automatically. The same one-day boundary sat on both outcomes.

### 4b. GLD 2026-09-18 — journal 1 contract, account 2

Found by the reconciliation tool **on its first live run**, with a sweep-placed 1-contract GTC
(`1007448830391`) standing against a 2-contract position. April's cause: **two separate 1-lot
condors at identical strikes, opened on different days.**

The failure mode, which nothing else in the system states: the GTC closes 1 of 2 contracts, the
sweep journals that as a **FULL** close (the fill's count matches the trade's), and the remaining
condor stays open at Schwab **with no journal trade, no standing exit and no 21-DTE alert —
invisible to the app.**

### 4c. SPY 2026-09-18 — no standing exit

`exitOrderId=null` at 44 DTE with nothing at Schwab, while the same sweep placed the SPY 9/11
GTC. Benign explanation (journaled after the run) not distinguishable from a failure without the
cron log. **If no GTC appears after the next sweep, that is a real signal.**

---

## 5. Schwab AGGREGATES identical-strike positions — a corrected assumption

The reconciliation design assumed two condors on one underlying+expiration would surface as 8
legs and drop to `OTHER`. **Wrong.** Schwab merges identical-strike positions into **one row at
the summed quantity**, so two 1-lots are indistinguishable from one 2-lot. Only *differing*
strikes produce 8 legs.

Consequence: the app cannot cleanly journal two same-strike condors as separate trades.
`underlying|expiration` is the key for **both** the Monitor's GTC chip and the sweep's pre-place
guard.

---

## 6. v2.8 — journal ⇄ account reconciliation

**The missing guard.** Every other lifecycle event has a fallback that catches a miss later — a
missed entry by Import, a missed close by Record Close. **A missed roll had neither:**
`deduplicateCandidates` keys on underlying+expiration, so a same-expiration roll is filtered as
`alreadyImported` and its changed strikes are never compared to what is journaled.

`lib/journal/reconcile.ts` (pure, 27 tests) + `scripts/reconcile-journal.ts`:

| Verdict | Severity | Meaning |
|---|---|---|
| `DRIFT` | critical | matched, but strikes or contracts differ |
| `PHANTOM` | critical / warning if expired | journal says open, account holds nothing |
| `UNCOMPARABLE` | warning | one side cannot be derived — **never rendered as healthy** |
| `UNIMPORTED` | info | condor at Schwab with no open trade |
| `MATCH` | ok | agreed |

Design points, all deliberate:

- **Journal side is `currentStructure` ONLY — never a second fold.** My first audit script
  hand-rolled one, ordered by `createdAt` instead of batching by `occurredAt` with
  closes-before-opens, and reported two healthy trades as having vacant legs. Two derivation
  paths is exactly what v2.3 deleted `exitInputFromOpenEvents` to end. I reintroduced it in a
  diagnostic and it lied within minutes.
- **Report-only, never repairs.** The account is truth for **structure**, but the journal is the
  only record of **prices and intent** — precisely what repairing a missed roll needs and what
  nothing can reconstruct.
- **The two DRIFT kinds get separate explanations.** The first draft blamed "an unjournaled roll"
  for all of them; the first live run hit a contracts-only mismatch where that is simply wrong.

---

## 7. v2.8.1 — wired into the cron, flag-only

**DECIDED (April): a DRIFT FLAGS, it does NOT block placement.** Blocking would have made §4a
structurally impossible, and was still rejected: this module is a heuristic sitting in front of a
mechanical chain that already works (pre-place guard, 24-DTE floor, refuse-don't-guess), and a
false positive must never suppress a legitimate GTC. **Nothing in the cron may consult
`report.reconciliation` when deciding what to place.**

Isolation, because this adds a Schwab call to a live-money cron:

- Its own try/catch, **deliberately not part of step 0's wholesale fetch** — step 0 aborts the
  sweep by design (an empty order list would permit duplicate GTCs) and this must never have that
  power.
- **`ran: false` is NOT "nothing found."** A fetch failure flags `RECONCILIATION DID NOT RUN —
  this is NOT a clean bill of health`. An absent warning identical to a clean bill is how the
  `/quotes` 404 hid for weeks (v2.6.1). Same lesson, third application.
- Only criticals narrate; the rest are counted, so a healthy run does not bury the sweep's output.
- `flagged.tradeId` widened to `string | null` — an `UNIMPORTED` finding has no trade id.

Cost: one extra Schwab `GET` per weekday run.

---

## 8. Decisions locked (do not reopen without April)

1. **`LP < SP <= SC < LC`.** `SP > SC` is never valid.
2. **A butterfly is an `IRON_CONDOR`**, not a new `PositionKind`.
3. **Butterflies arise from rolls only.** The scanner must never create one;
   `buildCondorOrder` and `PlaceOrderPanel` stay strict.
4. **Butterfly exits are placeable** (fixture 1007469542479); **butterfly entries are not.**
5. **Reconciliation flags, never blocks**, and never repairs.
6. **GLD: journal the second condor as its own trade** — do not merge. The event log is
   append-only; a second entry's four `open` events would give eight, which `currentStructure`
   refuses outright. Accepted cost: trade B's exit is placed by hand, and reconciliation reports
   both as `UNCOMPARABLE` (drift detection on GLD is **suspended** until one closes).

---

## 9. Open items

1. **Journal the second GLD condor** — manual **New Trade** form, *not* Import (which filters it
   as `alreadyImported` and would build a 2-contract candidate). Then place its 50% GTC by hand;
   the sweep will flag rather than place it. This clears the CRITICAL to two warnings.
2. **SPY 2026-08-28 butterfly has no standing exit** — 23 DTE, past `PLACEMENT_MIN_DTE`. Manual
   GTC at **$4.30**, or ride to the 21-DTE alert on Aug 7.
3. **SPY 2026-09-18** — expect a $2.58 GTC at the next sweep; absence is a signal.
4. **Butterfly ENTRY fixture** — only if the app should ever open one. Currently it should not.
5. **XSP place-and-cancel fixture** (v2.4 step 7) — still queued, unchanged.
6. **v2.3.1 roll-form explicit prices** — `RollTradeSchema` still coerces `Number('') → 0`.
7. **Board #17** — expiration date on the Monitor (carried from Session 19).
8. **Reconciliation cannot see credit.** It compares legs and counts only. A trade journaled at
   the wrong *credit* remains invisible to everything.

---

## Pickup checklist

```
SteelEagle post-Session 20 (2026-08-04). State: v2.7 butterfly recognition,
v2.7.1 exit gate discharged (fixture 1007469542479 — Schwab records a
butterfly as IRON_CONDOR, identical to a condor), v2.8 journal/account
reconciliation, v2.8.1 wired into the cron FLAG-ONLY. 534 tests ·
1/2 cron slots · no pending migrations.

STRUCTURAL RULE: LP < SP <= SC < LC. SP > SC is never valid.

FIRST, ask April:
- Did you journal the second GLD 2026-09-18 condor? Until then the sweep
  flags RECONCILIATION DRIFT as CRITICAL every run (correctly).
- Did SPY 2026-09-18 get its $2.58 GTC? If not, check the Vercel cron log
  — absence is a real signal, not noise.
- SPY 2026-08-28 butterfly: manual GTC at $4.30, or ride to 21-DTE (Aug 7)?
- Did reconciliation appear in the sweep report at all? (report.reconciliation
  — `ran:false` means it did NOT run, which is NOT a clean bill.)

RUN THIS FIRST:
  npx tsx --env-file=.env.local scripts/reconcile-journal.ts
  (read-only; exit 1 = critical findings)

DO NOT:
- Let anything in the placement path consult report.reconciliation.
- Loosen the butterfly refusal in order-ticket.ts (entry stays unpinned).
- Add a second leg-derivation path. currentStructure is the only one.

Read first: docs/steeleagle-v2-7-iron-butterfly-spec.md (incl. the v2.7.1
section), lib/journal/reconcile.ts header, CLAUDE.md
```
