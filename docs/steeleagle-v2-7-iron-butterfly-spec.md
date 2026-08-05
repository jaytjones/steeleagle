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

## What would lift the placement gate

Same three steps as v2.4 step 7 for XSP, and it is April-manual:

1. Open (or use a rolled-into) iron butterfly in TOS.
2. Place a deliberately **unfillable** GTC close on it, dump via
   `scripts/dump-working-orders.ts`, read the real `complexOrderStrategyType`, **cancel**.
3. Pin the payload as a golden fixture, then widen the builders' types from the
   `'IRON_CONDOR'` literal and relax the `SP === SC` refusal in all three order-path sites.

Until then the refusal stays. Flipping it without the fixture is a live-money change.
