# SteelEagle v2.15 — gated auto-journal, ROLLS (pre-code analysis)

**Status:** design, not built. Written 2026-10-30 (Session 27) from the real code, not
from the v2.11 spec. Where this and `steeleagle-v2-11-fill-ingestion-spec.md` §8.3
disagree, this wins — §8.3 was written before v2.14 existed.

**Discharges:** the "rolls to be revisited" half of v2.14's scope decision (JJ, 2026-08-20).

---

## 0. Decisions locked by JJ, 2026-10-30

1. **One-sided rolls are the norm.** On a four-leg position (condor or butterfly) JJ
   almost always rolls TWO legs — the put spread or the call spread. The design is
   built for that shape; a four-leg (8-event) roll is admitted only because the same
   invariants cover it for free, never as the target case.
2. **Same-expiration rolls only.** A roll out in time changes the trade's
   `underlying|expiration` key, produces a diagonal mid-roll, and already gets the
   `MANUAL GTC` chip. It stays an inbox card.
3. **The GTC is HELD after an auto-journaled roll until JJ confirms with one click.**
   JJ may lift this later; for now, the first time an automatic journal write can reach
   the placement path, it reaches it only by WITHHOLDING a placement — never by making
   one.

Previously locked and unchanged: single-ticket rolls only (split rolls stay manual —
v2.11 §8.3 pairing is not attempted); the gate is the ZERO RESIDUAL, all-or-nothing
(v2.14); `complexOrderStrategyType` is never read (v2.11 F2); `legRole` from
`close-from-fill` is never reused for rolls (v2.11 F3).

---

## 1. Why closes shipped first, restated as the hazard this design must answer

A zero residual proves COMPLETENESS, not CORRECTNESS. A roll and a close-plus-open have
identical position arithmetic, so the gate bounds which orders are ELIGIBLE and never
checks the interpretation (v2.14 header). A misread close announces itself next sweep as
a DRIFT; **a misread roll does not** — the structure matches the account, reconciliation
reads MATCH, and the only thing wrong is the running credit, which is exactly the number
the next 50% GTC is priced from. Schwab accepts that order (the legs are held) and it can
fill.

So the answer has two parts, and both are needed:

- **Narrow the interpretation surface until a misread is implausible** (§3). A single
  ticket carrying both `_TO_CLOSE` and `_TO_OPEN` legs on the same roles, same
  underlying, same expiration, owned by exactly one open trade, is not a close-plus-open
  of two different trades in any workflow TOS supports. The ambiguity v2.14 was guarding
  against lives in the SPLIT roll, which this does not touch.
- **Hold the one live-money consequence behind JJ's eyes** (§5). Even if a roll is
  misread, nothing is placed from it until she has looked at the journal entry.

---

## 2. What already exists (verified against the code, not the spec)

| Need | Where it already is | Reusable as-is? |
|---|---|---|
| Recognise a single-ticket roll | `classify-fill.ts` → `shape: 'ROLL'` — requires opens AND closes in one ticket, roles unique within each direction, every `roll_open` matched by a `roll_close` on the same role | **Yes.** It already encodes `RollTradeSchema`'s superRefine. |
| Map instructions to roles | `classify-fill.ts` F3 table (`ClassifiedLeg.role`, `.action`) | Yes. |
| Find the owning trade | `match-fill.ts` `closeOwners(fill, trades)` — matches the fill's **closing** legs against the trade's `open`/`roll_open` events, returns a LIST | **Yes.** It filters on `action === 'close'`, so a roll's two closing legs identify the trade the same way a close's four do. Key-site (c) stays in the type. |
| Residual gate + interval + disposition | `auto-close.ts` `planAutoCloses` — `GATE_STATUS`, `inInterval`, `disposition === 'pending'` | The LOGIC, yes; the module is close-specific. Extract the gate (§4). |
| Turn the fill into form rows | `fill-to-draft.ts` `fillToPrefill` — already builds roll rows (closes before opens, `creditDebitFor`) | For the CARD. The write path needs NUMBERS and must refuse a null price; it gets its own mapper (§4). |
| Write the roll | `lib/db/journal.ts` `rollTrade(tradeId, input)` — transactional, uses `existing.contracts` for every leg, folds totals, `exit_order_id = NULL` | **Almost.** Takes no `provenance`; `insertEvent` defaults `source` to `'manual'`. Needs the same optional provenance arg `closeTrade` has. |
| Report + banner | `sweep-report.ts` `AutoJournalReport`, the NOTE channel | Extend (§6). |
| Golden fixtures | `golden-fills.fixture.ts` pins `1007454721397` (SPY 09-11, `CONDOR`), `1007483420023` (SPY 09-11, `CUSTOM`), `1007598809028` (GLD ×2) + the split pair | Three of the six single-ticket rolls. **`1007450735138`, `1007465290239`, `1007511371504` are NOT pinned** — dump with `scripts/dump-order.ts` and pin before writing the planner. |

Things the code does NOT have, and this design must not pretend it does:

- **No roll-event edit path.** `edit-close.ts` repairs `close` events only. A mis-journaled
  roll is repairable by hand SQL and nothing else. That is the strongest argument for §5
  (the hold) and for §3's narrowness — and it is an open question (§8.1).
- **No per-trade placement hold.** The only pause is `user_settings.pause_exit_placement`,
  global. §5 adds a trade-level one.
- **`setFillDisposition` has one caller** (the v2.14 write). Nothing in the UI sets
  `dismissed`. Unchanged here.

---

## 3. Eligibility — every condition, in order, with its refusal

Mirrors `planAutoCloses` exactly where it can. A condition that fails LATER in the list is
a `refused` entry (recorded, inbox card stays); one that fails EARLIER is a silent skip
(not ours). Same posture as v2.14: refusals are recorded, not flagged.

| # | Condition | On failure |
|---|---|---|
| G | `interval !== null` and `balanceStatus === 'BALANCED'` | Gate CLOSED. Nothing written, from any shape. |
| 1 | `disposition === 'pending'` | skip — JJ's judgement outranks the gate |
| 2 | `shape === 'ROLL'`, `filled`, `status === 'FILLED'`, `refusals.length === 0` | skip — not a roll, or the classifier already declined |
| 3 | `occurredAt` in `(from, to]` | skip — tonight's proof covers tonight's interval only |
| 4 | `closeOwners(fill, trades).length === 1` | 0 → skip (already journaled, or no such trade); **>1 → REFUSE** (same-strike pair — GLD) |
| 5 | `fill.contracts === trade.contracts` | REFUSE — a 2-lot ticket rolling an aggregated pair of 1-lot trades is refused HERE and at #4; a partial roll is never written |
| 6 | **Same expiration:** every leg's `expiration === trade.currentExpiration` | REFUSE — decision 2. (A `ROLL` ticket's `expiration` is null when its legs span two — refuse on that too.) |
| 7 | **One-sided shape:** closes and opens are the same size, every role closed is reopened (the classifier already guarantees the converse), and **all four legs share one `putCall`** for a 2+2 | 2+2 mixed putCall → REFUSE (that is not a spread roll); 4+4 → allowed, see decision 1 note |
| 8 | **Every leg has a real price** (`price !== null`) | REFUSE — a pre-fill may show a blank; a write never fabricates (v2.11 doctrine) |
| 9 | **Post-roll structure is well-formed:** fold `trade.events + proposed events` and require `LP < SP <= SC < LC`, no vacant role, one expiration | REFUSE — see §3.1 |

### 3.1 Condition 9 must NOT use `structureRefusal` directly

`currentStructure` refuses on two SYMBOL-level grounds before it looks at a single leg —
`hasAmbiguousRoot` (SPX/NDX/RUT) and `isOrderFixturePinned` — because its output prices
an order. An auto-ROLL is a journal write, not an order: an SPX roll is exactly as
journalable as an SPY roll. Using `structureRefusal` here would silently make every index
roll refuse forever, indistinguishable from "no rolls happened" — the v2.6.1 shape.

Required: a **structure-only** probe, extracted from the fold's leg work with the two
symbol checks lifted out. `currentStructure` then becomes "symbol checks, then the
structure-only fold" — one fold, two callers, no second copy of the `LP < SP <= SC < LC`
invariant (the v2.7 lesson: the ordering check lives in ONE predicate).

Why refuse at all, when the fill is what actually happened? Because a crossed body is
refused at every write site in the repo except the manual Roll form, and the manual form
has JJ's eyes on it. The auto path does not. A crossed result means either the
classifier mis-assigned a role or JJ did something unusual in TOS; both want the card.

### 3.2 What this means for GLD-style scale-ins

Two same-strike 1-lot trades rolled by one 2-lot ticket **can never be auto-journaled** —
#4 and #5 both refuse. That is correct and should be stated in the summary so JJ does
not wait for it. Same answer v2.14 gives their close.

---

## 4. Pure modules (build pattern step 1)

```
lib/journal/auto-journal-gate.ts     NEW — extracted from auto-close.ts
  GATE_STATUS, AutoJournalInterval, inInterval(), gateDecision()
  → auto-close.ts imports these; its tests pass unchanged.
  One gate predicate, two consumers — the isPriceableStructure doctrine.

lib/journal/roll-from-fill.ts        NEW — mirrors close-from-fill.ts
  rollInputFromFill(fill: FillClassification): { occurredAt, events: RollEventInput[], contracts }
  Numbers, not strings. Throws on any null price, on a non-ROLL shape, on
  mixed expirations. Closes before opens (as fillToPrefill), creditDebit via
  creditDebitFor(action, role) — the F3 inverse, already written.
  Does NOT import close-from-fill's legRole (v2.11 F3).

lib/journal/current-structure.ts     CHANGE — split the fold
  foldStructure(events): StructureFold | throws   (leg work only, no symbol checks)
  currentStructure(symbol, events) = symbol checks, then foldStructure
  structureOnlyRefusal(events): string | null      (new non-throwing probe)
  Existing tests pass unchanged; new tests pin that an SPX event log passes
  structureOnlyRefusal and still fails structureRefusal.

lib/journal/auto-roll.ts             NEW — mirrors auto-close.ts
  planAutoRolls({ fills, trades, interval, balanceStatus }): AutoRollPlan
  AutoRollPlan = { gate, gateReason, write: AutoRollWrite[], refused, considered }
  AutoRollWrite = { orderId, tradeId, symbol, contracts, events: RollEventInput[], occurredAt }
  summarizeAutoRoll(plan)
```

`planAutoRolls` carries the EVENTS in its write items (unlike `planAutoCloses`, which
re-derives from the order at write time via `closeInputFromFilledExit`). Reason: condition
9 needs the proposed events to fold, so the planner has already built them; building them
twice is the two-calls-can-disagree hazard the cron comments warn about. The route still
cross-checks `contracts` against the live order as step (d) does today.

### 4.1 DB layer

`rollTrade(tradeId, input, provenance?)` gains the same optional third argument
`closeTrade` has — `{ source, schwabOrderId }` — threaded to every `insertEvent`.
Plus one more field, `holdExitPlacement: true`, which sets the §5 column **inside the same
transaction** as the events and the `exit_order_id = NULL`. The hold and the roll must
never be separable: a roll written without its hold is the exact hazard decision 3 exists
to prevent.

---

## 5. The hold (decision 3) — and why it does not breach the isolation rules

**Column:** `trades.exit_hold_order_id text null`. Non-null = "an automatic roll from
this order was journaled and JJ has not yet confirmed it; place nothing." The order id is
the WHY, so the chip, the flag and the confirm card can all name the fill.

Migration `migrations/2026-XX-XX-exit-hold.sql`, applied in Neon BEFORE deploy (the
`TRADE_SELECT` gains a column), folded into `supabase-schema.sql` in the same commit.

**Planner:** `SweepTradeInput.exitHoldOrderId?: string | null`. In (c) PLACE, right after
the `exitOrderId !== null` and DTE checks and BEFORE `priceable`:

```
if (trade.exitHoldOrderId) {
  plan.toFlag.push({ ..., reason: `${symbol} ${expiration} — GTC HELD: the roll journaled
    automatically from order ${id} is awaiting your confirmation on the Journal page`,
    severity: 'routine' })
  continue
}
```

**Why this is allowed under the standing rules:**

- "Nothing in the placement path may read `schwab_fills` / `sweep_runs` / `position_snapshots`"
  — still true. The planner reads a **`trades`** column, the same class of input as
  `exit_order_id` and `contracts`. The ledger tables stay write-only-from-cron.
- "A DRIFT flags, it does not block" — still true. This is not reconciliation. It is a
  state JJ's own journal carries, set by a write that has already happened, cleared by
  her click. It is structurally the trade-level twin of `pause_exit_placement`.
- The fail-safe direction is preserved: the hold can only WITHHOLD. There is no code path
  by which an auto-roll causes a placement this run — step (d) still runs dead last, and
  the next run sees the hold.
- `rollTrade` already nulls `exit_order_id`, so without the hold the next sweep would
  place a fresh 50% GTC from the auto-journaled credit with no eyes on it. The hold is the
  only thing standing between a misread roll and a live order.

**Severity: routine.** It recurs every night until JJ clicks, and the confirm card is the
delivery surface. v2.9 reserved `routine` for the two permanent symbol-level refusals;
this is a third, and it is the same shape — a known, on-screen, by-design condition that
must not hold the banner red. **Escalate** (optional, §8.3): after N runs unconfirmed the
flag turns critical, because "no GTC working on an open position" is a risk condition
that should not be allowed to become wallpaper either.

**Clearing it:** server action `confirmAutoRollAction(tradeId)` → `ActionResult`, `UPDATE
trades SET exit_hold_order_id = NULL WHERE id = $1 AND exit_hold_order_id IS NOT NULL`,
`revalidatePath('/journal')`. Nothing else — the next sweep places normally. If JJ does
NOT agree with the roll, there is no "reject" button, because there is no roll-edit path
(§8.1); the card says so and points at the events.

**Rolling by hand clears nothing.** A manual `rollTradeAction` on a held trade keeps the
hold — the old auto-roll's events are still in the log, and the manual roll on top of
them is exactly the case that needs eyes most.

---

## 6. Cron wiring (build pattern step 2)

Inside step (d), **rolls BEFORE closes, trades re-read between them.** A roll in the
morning and a close of the rolled legs in the afternoon is one interval: the close's
owners are only findable once the roll's `roll_open` events exist. The other order leaves
the close with `owners.length === 0` tonight and OUTSIDE tomorrow's interval — an inbox
card forever, for a case that was fully provable. Sequential, each in its own try/catch;
a roll write that fails simply leaves the close refusing on ownership, which is correct.

Per write item, same shape as the close loop:

1. `orderById.get(id) ?? getOrder(hash, id)`; re-derive `contracts` from the live order
   and refuse on disagreement with the ledger (as today).
2. `RollTradeSchema.parse({ occurredAt, newExpiration: null, notes, events })` — the same
   schema the Roll form and `rollTradeAction` enforce. `newExpiration` is **always null**
   under decision 2; a non-null here is a bug, not a feature.
3. `rollTrade(tradeId, input, { source: 'schwab_fill', schwabOrderId, holdExitPlacement: true })`.
4. `setFillDisposition(orderId, 'journaled', tradeId)` — after, own try, as today.
5. A throw → `failed[]` + a **critical** flag (an app fault, not operator work).

Notes text: `Journaled automatically from Schwab order <id> — GTC held pending your
confirmation.` The journal must say the entry was not typed by JJ.

**Report:** `AutoJournalReport` gains `rolls: { written, refused, failed }` alongside the
existing close fields (rename the existing to `closes` is cleaner but touches the stored
`sweep_runs.report` shape; keep the old fields in place and ADD `rolls`). NOTE line:
`Journaled the roll of SPY 2026-11-20 for you — order <id>. GTC held until you confirm.`

---

## 7. UI (build pattern step 3)

- **TradeCard:** when `trade.exitHoldOrderId` is set, a banner above the timeline:
  "Rolled automatically from order <id> on <date CT>. Check the legs below, then
  **Confirm & arm GTC**." One button → `confirmAutoRollAction`. Shows the roll batch's
  legs and prices (they are the newest `roll_*` events; already rendered).
- **Monitor chip:** `exit-links.ts` — a held trade renders `GTC HELD` (amber, like
  `MANUAL GTC` but with the confirm link), not `NO GTC`. The chip and the planner must
  agree via the one column, not a second predicate.
- **Inbox:** nothing — a journaled roll becomes `ALREADY_JOURNALED` on the next read and
  the card disappears, as closes do today.
- `Trade` type + `TRADE_SELECT` + `mapTradeRow` gain `exitHoldOrderId`.

---

## 8. Open questions for JJ

1. **No roll-edit path.** v2.12 made `schwab_fill` CLOSES editable because the sweep had
   written 16 and they were unrepairable. The same will be true of auto-rolls from the
   first write. Options: (a) ship with hand-SQL as the repair and the hold as the
   safeguard; (b) build roll editing first (prices only — structure stays immutable, as
   with closes). **Recommendation: (a) for the first version, (b) queued** — the hold
   means a wrong roll costs an inbox-style delay, not a mis-priced order.
2. **Should 4+4 single-ticket rolls be admitted?** Decision 1 says they are rare. The
   invariants cover them at no cost; refusing them would be a rule with no hazard behind
   it. **Recommendation: admit**, and let the dry run (§9) say whether any exist.
3. **Escalation of the hold flag** from routine to critical after N unconfirmed runs.
   **Recommendation: 3 runs** (a long weekend plus one), but this is a taste call.
4. **Butterfly results.** A one-sided roll that lands SP == SC is admitted by condition 9
   (`<=`) and the exit path is fixture-pinned (v2.7.1). Confirm this is intended — it is,
   by the v2.7 decision, but it will be the first time the app WRITES a butterfly rather
   than recognising one JJ typed.

---

## 9. Proof plan (before any production write)

1. Pin the three unpinned single-ticket rolls (`1007450735138`, `1007465290239`,
   `1007511371504`) via `scripts/dump-order.ts`. Strip `accountNumber` (v2.11 F7).
2. Unit: `planAutoRolls` against all six + the split pair + the SWVXX and cancelled-GTC
   fixtures (the gate must be unmoved by them). Every refusal row in §3 gets a test that
   names it.
3. **Replay dry run** — `scripts/dry-run-auto-roll.ts`, read-only over the 180-day ledger
   with the gate forced OPEN: for each eligible roll, build the events and compare them
   to the `roll_*` events JJ journaled by hand for that trade — strike, role, expiration,
   price, creditDebit, occurredAt. **The writer must reproduce her entries exactly.** Any
   mismatch is either a defect in the mapper or a hand-entry error, and both are worth
   knowing before the first automatic write. The v2.14 dry run found 0 writes; this one
   should find six.
4. Gates (`tsx --test`, `tsc --noEmit`, clean build), Finder-artifact sweep.
5. Migration applied in Neon; `TRADE_SELECT` round-tripped against the live DB.
6. First live exercise: the next one-sided same-expiration roll JJ does in TOS on a
   BALANCED night. Expected: a NOTE on the banner, a `GTC HELD` chip, a confirm card on
   the TradeCard, no placement until the click, placement on the sweep after it.
