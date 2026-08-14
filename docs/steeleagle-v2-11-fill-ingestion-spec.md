# SteelEagle v2.11 — Snapshot-anchored fill ingestion

**Status:** SPEC — no code written beyond `scripts/dump-filled-orders.ts` (read-only).
**Date:** 2026-08-14
**Supersedes nothing.** Extends v2.8 reconciliation from *detection* to *explanation*.

---

## 1. The gap

Every automatic-detection path in the app derives account truth from **positions** — a
snapshot. A roll is a *transition*, and a snapshot cannot show a transition. That is the
whole reason `lib/journal/reconcile.ts` exists and the whole reason it can only report.

| Event | Fallback today | Derives from | Gap |
|---|---|---|---|
| OPEN | Import from Schwab (manual trigger) | positions, enriched by filled orders | dedupes on `underlying+expiration` |
| CLOSE | sweep reconcile | **only** orders whose id is already in `trades.exit_order_id` | a TOS close is invisible |
| ROLL | none | — | — |

`reconcile.ts:22-26` states the governing constraint: *"the ACCOUNT is truth for STRUCTURE,
but the JOURNAL is the only record of PRICES and INTENT."*

**That is true of positions and false of orders.** `orderActivityCollection[].executionLegs[]`
carries real per-leg fill price, quantity and time. The repo already proves it twice —
`importer.ts:215-238` for opens, `close-from-fill.ts:78-89` for closes. Prices *are*
recoverable from the account. Only INTENT (`closeReason`, `notes`, `initialBpr`) genuinely
is not, and that is small and askable.

**The leverage:** `getWorkingAndRecentOrders(hash, 180)` is already called once per sweep
(`app/api/cron/snapshot-iv/route.ts:260`), with no status filter. Every manually-placed fill
is *already in memory in the cron* and is discarded every run. `getAccountSnapshot()` at
line 281 likewise fetches raw positions and drops them after `reconstructPositions`. No new
API call, no new rate limit, no new failure mode.

---

## 2. The identity (April, 2026-08-14)

Detection becomes an accounting identity rather than a heuristic:

```
positions(T₀)  +  Σ order effects in (T₀, T₁]  ==  positions(T₁)
```

If it balances, every structural change is explained by a known order — a **completeness
proof**, not a confidence score. A pure order-stream classifier has a silent-miss failure
mode (order outside the window, unparseable, dismissed as ambiguous) with nothing to detect
it. The balance check catches exactly that.

The residual is the valuable part. A non-zero residual is precisely **the class of events
that produce no order at all**: expirations, assignments, exercises. Those become detectable
without touching `/transactions` and without a new fixture. An expiration is self-identifying
— a position vanishes with no offsetting fill and the symbol's expiration is in the past.

**It also dissolves the aggregation problem.** `reconcile.ts:330-335` documents two 1-lot
condors as indistinguishable from one 2-lot. True of a *snapshot*; false of a *delta*. The
position row goes 0→1 one day and 1→2 another, each step carrying its own timestamp and
order id. Precisely: the delta resolves **detection**, not **representation** — the journal
still cannot hold two trades on one `underlying|expiration` key, so trade B's manual-GTC
problem is untouched. And it works only prospectively; there is no snapshot from before
GLD's second condor.

---

## 3. Doctrine section — what the live fixtures actually showed

Pulled 2026-08-14 via `scripts/dump-filled-orders.ts 14` (read-only). 54 orders, 19 FILLED,
11 with option legs. **These findings are the fixtures. Do not build the classifier from any
other source.**

### F1 — Rolls arrive as ONE mixed ticket. Usually.

Six historical rolls, all single tickets carrying mixed `_TO_OPEN` and `_TO_CLOSE` legs:

| orderId | date | underlying | closed → opened |
|---|---|---|---|
| 1007450735138 | 08-04 | SPY 08-28 | 680/700P → 720/740P |
| 1007454721397 | 08-04 | SPY 09-11 | 700/715P → 725/740P |
| 1007465290239 | 08-04 | SPY 08-28 | 720/740P → 745/765P |
| 1007483420023 | 08-05 | SPY 09-11 | 725/740P → 735/750P |
| 1007511371504 | 08-07 | GLD 09-18 ×2 | 330/350P → 365/385P |
| 1007598809028 | 08-14 | GLD 09-18 ×2 | 365/385P → 375/395P |

Single-ticket rolls make ROLL detection **exact** — no pairing heuristic needed.

**But split rolls also happen, and one happened today.** SPY 09-11 was rolled as two separate
`VERTICAL` tickets 4m28s apart:

- `1007598808689` 15:59:25 — ALL_CLOSE: BTC 750P @3.14, STC 735P @1.89 (net debit 1.25)
- `1007598809002` 16:03:53 — ALL_OPEN: STO 765P @5.60, BTO 750P @3.12 (net credit 2.48)

Both forms exist. The design must handle both, and must be able to **refuse** the second.

Note what the split roll does to the order stream: in isolation those are an independent
close and an independent open. Nothing in the two tickets says "roll". **The position delta
handles it natively** — 735P +1→0, 750P −1→+1, 765P 0→−1, and the two orders' effects sum to
exactly that. This is the case that most justifies April's snapshot anchor: even where
classification is unsure, the balance check still proves nothing was missed.

### F2 — `complexOrderStrategyType` is NOT reliable for classification. Never read it.

Observed on inbound orders:

| shape | observed values |
|---|---|
| 4-leg entry | `IRON_CONDOR` |
| 4-leg close | `IRON_CONDOR` |
| 2-leg vertical | `VERTICAL` |
| **4-leg roll** | **`CONDOR` ×5, `CUSTOM` ×1** |

`1007483420023` (`CUSTOM`) and `1007454721397` (`CONDOR`) are structurally identical SPY
09-11 four-leg put rolls. Schwab labelled them differently. A classifier keyed on this field
would silently miss one roll in six.

**Rule: classify from `instruction` alone.** Same doctrine class as `settlementType` meaning
AM/PM. This does not affect the outbound builders, which correctly hardcode `IRON_CONDOR`
for their own tickets — but it is a live trap for anything reading orders back.

### F3 — The leg-role table needs all four instructions. Do not reuse `legRole`.

`close-from-fill.ts:31-36` derives the role as `short = instruction.startsWith('BUY')`. That
is correct for a **pure close** and **wrong for a roll**, where `BUY_TO_OPEN` is a long.

| instruction | side | journal event |
|---|---|---|
| `BUY_TO_CLOSE` | was SHORT | `roll_close` |
| `SELL_TO_CLOSE` | was LONG | `roll_close` |
| `SELL_TO_OPEN` | becomes SHORT | `roll_open` |
| `BUY_TO_OPEN` | becomes LONG | `roll_open` |

### F4 — All six observed rolls are one-sided put rolls, and they fit `RollTradeSchema`

Two legs closed + two opened, same `putCall`. Roles map to `roll_close short_put` +
`roll_close long_put` + `roll_open short_put` + `roll_open long_put`, which satisfies
`RollTradeSchema`'s superRefine (every `roll_open` has a matching `roll_close` on the same
role). No schema change needed for the observed cases.

### F5 — Execution detail is complete and quantity-carrying

```json
{ "legId": 1, "quantity": 2, "price": 6.83, "time": "2026-08-14T16:04:15+0000" }
```

Identical to what `close-from-fill.ts` already parses. Reuse that quantity-weighted average.

### F6 — `price` on a roll ticket is the NET credit/debit

`orderType: "NET_CREDIT"`, `price: 2.02`. Useful as a cross-check against summed leg fills;
never as a substitute for them.

### F7 — `accountNumber` IS present in every raw order body

`dump-order.ts` understates this ("the order body itself carries no account hash, but check
for an `accountNumber` field"). It is there, on every order, six occurrences in a 14-day
window. **Anything persisting raw order JSON must strip it at the ingestion boundary**, not
at the render boundary. Directly constrains §5.

---

## 4. Module design — all pure, all `lib/`, tests first

```ts
// lib/journal/position-delta.ts
type SymbolQty = Map<string, number>            // occSymbol → signed net qty
positionsToQty(rawPositions: unknown[]): SymbolQty
diffPositions(before: SymbolQty, after: SymbolQty): SymbolQty   // signed change

// lib/journal/order-effects.ts
orderEffect(order: SchwabOrderDetail): SymbolQty   // from instruction + quantity
sumEffects(orders: SchwabOrderDetail[]): SymbolQty

// lib/journal/balance.ts
type BalanceResult = { balanced: boolean; residual: SymbolQty; explanation: Residual[] }
type Residual =
  | { kind: 'EXPIRED';    occSymbol: string; qty: number }   // expiration in the past
  | { kind: 'UNEXPLAINED'; occSymbol: string; qty: number }  // critical
checkBalance(delta: SymbolQty, effects: SymbolQty, now: Date): BalanceResult

// lib/journal/classify-fill.ts
type FillShape = 'OPEN' | 'CLOSE' | 'ROLL' | 'PARTIAL_CLOSE' | 'NOT_CONDOR' | 'AMBIGUOUS'
classifyFill(order: SchwabOrderDetail): FillClassification    // instruction-only (F2)

// lib/journal/match-fill.ts
matchFill(c: FillClassification, openTrades: ReconcileTrade[]): FillProposal
```

**Diff at the OCC-symbol level, never the condor level.** `groupIntoCondors` bails to
`incomplete` on anything non-textbook; a map diff has no such failure mode and always yields
a well-defined delta. The diff layer must be *dumber* than the grouping layer, and therefore
more reliable. Both sides of the identity live in the same units.

**Match on full structure, never on `underlying+expiration`.** A ROLL's `_TO_CLOSE` legs must
match a subset of a live trade's `currentStructure()` by role + strike + expiration. This is
the single change that fixes the bug `deduplicateCandidates` has: a same-expiration roll is
no longer filtered as `alreadyImported`.

**The interval collapses the ambiguity surface.** With daily snapshots, split-roll pairing
considers one trading day of orders, not 180. Most days contain zero or one order.

---

## 5. Schema — `position_snapshots` and `schwab_fills`

Both mirror `sweep_runs`: **write-only from the cron, read-only everywhere else.** Nothing in
the placement path may read either. Reconciliation flags, it does not block (April,
2026-08-04) and the same rule applies to its inputs.

```sql
create table if not exists position_snapshots (
  id         uuid        primary key default gen_random_uuid(),
  taken_at   timestamptz not null,
  positions  jsonb       not null,   -- raw Schwab positions array, accountNumber stripped
  created_at timestamptz not null default now()
);
create index if not exists position_snapshots_taken_at_idx on position_snapshots (taken_at desc);

create table if not exists schwab_fills (
  order_id      text        primary key,        -- idempotency key. NOT underlying|expiration.
  entered_time  timestamptz not null,
  close_time    timestamptz,
  underlying    text,
  shape         text        not null,           -- classifyFill result
  legs          jsonb       not null,           -- instruction/occ/qty/fill price, stripped
  disposition   text        not null default 'pending',  -- pending|journaled|dismissed
  trade_id      uuid,                           -- set when journaled
  ingested_at   timestamptz not null default now()
);
```

`order_id` as the primary key is the point: "have I journaled this fill?" becomes an exact
question with an exact answer, replacing the fuzzy `underlying|expiration` match that Schwab
aggregation has already broken once on GLD. Positions are aggregated; **orders are not**.

Per F7, strip `accountNumber` in the ingestion function, before the row is built.

---

## 6. Failure semantics — the part that must not be got wrong

- **No prior snapshot ⇒ `UNANCHORED`, never `MATCH`.** This is the trap CLAUDE.md documents
  twice (the `/quotes` 404 hiding as silence; `reconciliation.ran: false` ≠ "nothing found").
  No anchor means *cannot compare*, in the same family as `UNCOMPARABLE`.
- **Ingestion and interpretation are separate.** Ingestion must never fail the sweep;
  interpretation may refuse freely. Isolated try/catch, same posture as the v2.8 wiring.
- **Bootstrapping:** the first snapshot is only an anchor. The first real diff is one trading
  day later. Ship expecting a one-day dead period, and render it as `UNANCHORED`, not clean.
- **A missed cron day widens the interval**, it does not break it — orders are fetched by
  time. But a gap longer than the fetch window is `UNANCHORED`.
- **`fromEnteredTime` filters on placement, not fill.** A GTC entered >180 days ago and
  filled yesterday falls outside the window; its fill would land as an `UNEXPLAINED`
  residual, which is the correct and safe outcome.

---

## 7. Delivery — inbox first, gated auto-write later

The cron ingests, classifies and proposes; it writes nothing to `trades`/`trade_events`. The
dashboard renders an **Unjournaled Activity** queue:

> **SPY 09-11 — ROLL** · order 1007483420023 · Aug 5, 12:55 PM CT
> BTC 740P @4.26 · STC 725P @2.80 · STO 750P @5.77 · BTO 735P @3.69 — net credit $0.62
> `[Journal it]` `[Not a roll]`

One click into a pre-filled Roll form. The burden being removed is not clicking a button, it
is retyping eight legs of strikes and prices.

**When auto-write is eventually enabled, gate it on the interval balancing to zero residual
— not on classifier confidence.** If anything in a day is unexplained, *everything* from that
day goes to the inbox instead. Mechanical, conservative, no judgment calls, consistent with
the rest of the codebase.

This also completes v2.8: a DRIFT today says "the journal is wrong" with no remedy. With the
ledger, a DRIFT arrives attached to the order that caused it.

---

## 8. Open decisions

1. **Auto-written closes would be uneditable.** `lib/journal/edit-close.ts` deliberately only
   repairs `close` events with `source: 'manual'`. A close written as `schwab_fill` falls
   outside the existing repair path. Either widen `edit-close` or accept that auto-journaled
   closes are final. **Needs a decision before any auto-write.**
2. **`initialBpr` is not in the order response.** An auto-detected OPEN still needs operator
   entry (`enteredBpr` refuses 0 by design). Opens can never be fully hands-off.
3. **Split-roll pairing window.** Today's example was 4m28s. Proposed: same underlying, same
   expiration, both legs' symbols overlapping, within 15 minutes, and **exactly one** candidate
   on each side — otherwise `AMBIGUOUS`.
4. **Snapshot cadence** is the cron's, i.e. daily at 21:15 UTC. An intraday round-trip nets to
   zero in the delta and is invisible there — but fully visible in the order stream. Keep both;
   neither alone is sufficient.

## 9. What this does NOT do

- It does not repair the journal automatically (v2.11 scope is propose-only).
- It does not let two same-strike condors be journaled as separate trades. That is a
  `underlying|expiration` key problem in `trades`, untouched here.
- It does not read `/transactions`. Assignments/exercises surface as `UNEXPLAINED` residuals,
  which is enough to flag; naming them would need a live fixture first.
- It does not change anything in the placement path. Not one line.

---

## 10. Build order

1. `scripts/dump-filled-orders.ts` — **done**, read-only, fixtures pulled 2026-08-14.
2. Pin the six roll payloads + the split-roll pair as golden fixtures in
   `lib/journal/classify-fill.test.ts`.
3. `position-delta.ts` + `order-effects.ts` + `balance.ts`, pure, tests first.
4. `classify-fill.ts` against the pinned fixtures (F2/F3 are the tests that matter).
5. Migration + `lib/db/fills.ts`, applied in Neon before deploy.
6. Wire into the cron — isolated try/catch, can never abort a sweep, mirrors v2.8's wiring.
7. `match-fill.ts` + the Unjournaled Activity UI.
8. Only then revisit gated auto-write, with §8.1 decided.
