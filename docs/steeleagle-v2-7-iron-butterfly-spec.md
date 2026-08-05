# SteelEagle v2.7 — Iron Butterfly Recognition (Session 20)

**Status:** shipped · 500 tests · no migrations · no new cron slots
**Decision date:** 2026-08-04

## The ask

> "An Iron Butterfly is a special case of an iron condor, but our logic currently
> mandates that the iron condor structure is LP < SP < SC < LC. The Iron butterfly is
> LP < SP = SC < LC. We must update our logic to allow iron butterflies to be counted
> as iron condors."

Clarified by April in the same session:

> "Iron butterflies should only occur because of rolls. The scanner shouldn't create
> butterflies. But the positions monitor should still be able to recognize them as a
> type of condor."

## Where the constraint actually lived

Five sites, two risk tiers. The tiers get opposite treatment.

| Site | Tier | Outcome |
|---|---|---|
| `lib/strategy/reconstruct-positions.ts` `noOverlap` | recognition | relaxed to `<=` |
| `lib/journal/importer.ts` `groupIntoCondors` | recognition | relaxed to `<=` |
| `lib/journal/current-structure.ts` | order path | **new** butterfly refusal |
| `lib/schwab/exit-ticket.ts` `buildCondorExitTicket` | order path | refuses, with a specific message |
| `lib/schwab/order-ticket.ts` `buildCondorOrder` | order path | refuses, with a specific message |
| `components/scanner/PlaceOrderPanel.tsx` | order path | **unchanged** — stays strict |

Already butterfly-safe, no change needed: `closeInputFromFilledExit` and
`recordFillAction` (roles come from instruction + putCall, never strike),
`entryWingWidth` / BPR (`Math.max(putWidth, callWidth)` is correct for a butterfly),
all three zod schemas (they never compared strikes), `roll-alert`, `edit-close`.

## Decisions

**D1 — A butterfly is an `IRON_CONDOR`, not a new `PositionKind`.** April's words were
"counted as iron condors". Same four roles, same wings, same `wingWidth - credit` max
loss. A new kind would have forced every consumer — the 5-position cap, the BPR
tracker, `summarizeOpenRisk`, roll alerts, the journal-exit chip — to learn about it.

**D2 — The two shorts are told apart by putCall, never by strike.** This is what makes
D1 safe. Every role assignment in the codebase already keys on PUT vs CALL; equal
strikes were only ever a problem for the *ordering assertions*, not the *identification*.

**D3 — Recognition is free; placement is fixture-gated.** Both ticket builders hardcode
`complexOrderStrategyType: 'IRON_CONDOR'`, pinned from the real July 24 2026 dumps of
condor entries and closes. **Nobody has ever seen what Schwab records for an iron
butterfly.** Schwab's enum carries separate `BUTTERFLY` / `UNBALANCED_*` values, and
Schwab performs no server-side review — a wrong value submits and can execute. This is
the Schwab doctrine verbatim, and it is the same posture that gates the unpinned index
instruments. A butterfly therefore gets full Monitor recognition and a `MANUAL GTC`
chip; April places and closes it in TOS, and **Record Close** journals it.

**D4 — The scanner is untouched, by design.** `buildCondor` targets 16Δ shorts; a
butterfly's shorts are ~50Δ ATM, so it cannot produce one. `PlaceOrderPanel`'s client
check stays strict (`lp < sp && sp < sc && sc < lc`) to match `buildCondorOrder`.
Butterflies enter the system only via a roll or a manual TOS entry the importer picks up.

**D5 — Crossed bodies (SP > SC) are still refused everywhere.** `<=` admits the
zero-width body; it does not admit an inverted one.

## The pre-existing defect this closed

`currentStructure` compared **no strikes at all**. `isPriceableStructure` is the ONE
predicate the sweep planner and the Monitor's `MANUAL GTC` chip both consume, so any
mis-ordered structure — a butterfly, a crossed spread, a zero-width wing — passed it.
The Monitor rendered a green GTC-target chip, the planner queued the trade, and then
`buildCondorExitTicket` threw inside the placement loop at
`app/api/cron/snapshot-iv/route.ts:327`. The trade landed in `report.errors` on **every
sweep run, forever**, while the UI claimed it was covered, and no exit was ever placed.

Refusing at the predicate routes it to `plan.toFlag` with the refusal message verbatim
— the designed fail-safe. This was live before Session 20 and is independent of
butterflies; butterflies are just the case that surfaced it.

Three existing test fixtures had been quietly relying on the gap: two rolled a short put
onto the 700 long put (zero-width spread) and one rolled a short call to 800, above the
790 long call (crossed). All three would have thrown at the builder. Fixtures corrected
to structurally valid strikes; the fold semantics they pin are unchanged.

## Refusal messages

The butterfly refusal deliberately reads as *"the fixture is missing"*, not *"your trade
is malformed"* — it is a legitimate structure the order path cannot yet express:

> `currentStructure(SPY): the short strikes are both 745 — this is an iron BUTTERFLY,
> and no place-and-cancel fixture has pinned what Schwab records for one (the ticket
> builders hardcode complexOrderStrategyType "IRON_CONDOR", pinned from real condor
> closes). Refusing to guess an order payload (place this GTC manually).`

---

# v2.7.1 — the exit gate is discharged (same session, 2026-08-04)

## The fixture

April placed an unfillable GTC butterfly close the same evening. Dumped with the new
`scripts/dump-order.ts` (a single read-only `GET /accounts/{hash}/orders/{orderId}`):

- **orderId 1007469542479**, entered 2026-08-05T01:34:19Z, `PENDING_ACTIVATION`
- SPY 2026-08-28, **LP 745 / SP 765 / SC 765 / LC 785** — both shorts at 765
- qty 1, price 0.05

**The answer: `complexOrderStrategyType: "IRON_CONDOR"`.** Schwab records an iron
butterfly *identically* to a condor. There is no distinct butterfly type, and the leg
order is the same SC, LC, SP, LP:

| Field | Butterfly | Condor (pinned 2026-07-24) |
|---|---|---|
| `orderStrategyType` | `SINGLE` | `SINGLE` |
| `complexOrderStrategyType` | `IRON_CONDOR` | `IRON_CONDOR` |
| `orderType` | `NET_DEBIT` | `NET_DEBIT` |
| `duration` | `GOOD_TILL_CANCEL` | `GOOD_TILL_CANCEL` |
| `session` | `NORMAL` | `NORMAL` |
| leg order | SC, LC, SP, LP | SC, LC, SP, LP |

Pinned as `SPY_BUTTERFLY_GOLDEN` in `lib/schwab/exit-ticket.test.ts`.

## What changed

`SP === SC` no longer refuses on the **exit** path. The invariant relaxed from
`LP < SP < SC < LC` to **`LP < SP <= SC < LC`** in `buildCondorExitTicket` and in
`currentStructure`. Butterflies are now priceable: the sweep auto-places their 50% GTC.

## What deliberately did NOT change

**`buildCondorOrder` still refuses butterflies**, on two independent grounds:

1. The fixture is a **CLOSE** (`NET_DEBIT` / `*_TO_CLOSE`). A butterfly **entry**
   (`NET_CREDIT` / `*_TO_OPEN`) has never been recorded. The doctrine still binds.
2. Butterflies arise from **rolls only** (April, 2026-08-04). The app must never open
   one. `buildCondor` cannot produce one anyway (16Δ vs ~50Δ shorts), and
   `PlaceOrderPanel` stays strict — so this fires only on a hand-edited submit.

`order-ticket.test.ts` pins that asymmetry with a test that says, in as many words, not
to "fix" it by loosening the assertion.

## Also found while dumping (unrelated to the milestone, and more urgent)

The order's strikes did not match the journal. Cross-checking Schwab positions against
`listTrades` showed the real SPY 2026-08-28 position **is** the butterfly
(745/765/765/785), while the journal still read 720/740/765/785 — **the second roll had
never been journaled** (confirmed by April).

Consequences, in order of severity:

- The sweep prices GTCs off the journal. Had it placed for this trade, the close would
  have carried `BUY_TO_CLOSE 740P` / `SELL_TO_CLOSE 720P` — legs not held. Those do not
  close anything; they **open** a short 720/740 put spread.
- It did not place. Verified: `exitOrderId=null`, and no order at Schwab on those legs.
  What prevented it was `PLACEMENT_MIN_DTE = 24` with the trade sitting at exactly 24
  DTE, going to 23 the next day — **the calendar, not a guard**. The pre-place guard
  would also have caught it while April's manual GTC stood, but that is transient.
- `netCredit` for the trade is still missing the second roll's cash, so the 50% target,
  P&L, and anything Record Close writes are computed from wrong numbers until the roll
  is journaled.

Once that roll is journaled, v2.7.1 handles it correctly end to end: `SP == SC` folds to
a butterfly, `currentStructure` prices it, and the sweep places a real 745/765/765/785
close against the position that actually exists.

**Standing lesson:** an unjournaled roll is not a bookkeeping lag — it is a live
mis-pricing of a real order. Nothing in the app can detect it, because the journal is
the only record of intent. This is the second time the journal and the account have
diverged (cf. the Session 15 blank-price corruption); both were caught by looking at
Schwab, not by the app noticing.
