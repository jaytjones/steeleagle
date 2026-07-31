# SteelEagle v2.6.1 — Delta-staleness marker (roll-alert observability)

**Date:** 2026-07-31 · **Status:** specified + implemented in the same session
**Scope:** display + one route hardening. No Schwab write path, no DB, no migration.

---

## 1. Problem

The roll badge is an **exception-only** indicator: `RollBadge` renders for `ROLL`,
`BOTH_TESTED`, and `WATCH` only. `NONE` (healthy) and `NO_DELTA` (no usable greeks)
both render **nothing**.

That makes two very different states pixel-identical:

| Truth | Monitor shows |
|---|---|
| Both shorts well inside range — nothing to do | *(no badge)* |
| Live deltas unavailable — **no roll opinion at all** | *(no badge)* |

There are two distinct ways the second state arises, and neither was visible:

1. **`NO_DELTA` verdict** — `/quotes` answered but the greeks were 0/absent. Normal
   after hours (Schwab zeroes greeks, same class as the IV=0 bug); *alarming* in-hours.
2. **Annotation block threw** — `getOptionDeltas` failed, the route's isolating
   `try/catch` logged server-side, and every condor came back with
   `rollVerdict === undefined`. Also indistinguishable from healthy.

**This is not hypothetical.** Case 2 already ran silently in production: the v2.4 audit
of `lib/schwab/quotes.ts` found `getOptionDeltas` was building `/marketdata/v1/quotes?…`
while `marketGet` already prepends that prefix — **every call 404'd**, and the only
symptom was a log line the operator never sees plus roll badges that quietly never
appeared. The bug was caught by unrelated code-reading, not by the monitor.

A silent false negative on the only roll signal is the wrong failure direction for a
system whose whole posture is *refuse, don't guess*.

## 2. Decision

Add a **two-state delta marker** that renders whenever the roll verdict has no usable
delta, so the absence of a roll opinion is always stated rather than implied.

| Market state | Marker | Tone | Meaning |
|---|---|---|---|
| Regular hours (Mon–Fri 09:30–16:00 ET) | `Δ STALE` | amber, dashed border | **Something is wrong** — deltas should be live. Roll alerts are not running. |
| Outside regular hours | `Δ —` | dim slate | Expected. Greeks are zeroed after hours; roll alerts resume at 9:30 ET. |

Design constraints honored:

- **Never mimics `ROLL`.** The amber in-hours marker uses a *dashed* border and a
  `Δ`-prefixed label so it reads as "unknown", not "act now". A solid amber pill in the
  same cell already means "roll the untested side" — that meaning is not diluted.
- **Not noise after hours.** The dim variant is deliberately low-contrast. April sees
  the monitor after the close constantly; an alarm-colored badge every evening would
  train her to ignore the one that matters.
- **Truthful at all times.** The marker states the data situation in both states rather
  than appearing only when it's bad — a badge that only ever means "broken" is one you
  can't distinguish from "not implemented yet."

## 3. Changes

### 3.1 New pure module — `lib/strategy/market-hours.ts`

`isRegularMarketHours(now: Date): boolean` — ET wall clock via
`Intl.DateTimeFormat(…, { timeZone: 'America/New_York', hourCycle: 'h23' })`, weekday
Mon–Fri, `09:30 ≤ t < 16:00`. Pure; the clock is an argument, never read internally.

**Holiday calendar: deliberately absent.** On the ~9 market holidays a year (and on
1:00 PM early closes) the function reports "open" and a genuinely-expected `NO_DELTA`
renders as amber `Δ STALE`. That direction is chosen on purpose: the wrong-way error is
a **false alarm on a day April isn't trading**, never a silent miss on a day she is.
Same fail-loud logic as `getWorkingAndRecentOrders` throwing rather than returning `[]`.
A holiday table would need annual maintenance to buy back nine cosmetic days — not worth
the staleness risk of a table nobody remembers to update.

### 3.2 `lib/strategy/roll-alert.ts` — two additions

- `noDeltaVerdict(symbol, note)` — exported factory so the route can stamp a real
  `NO_DELTA` verdict instead of leaving `undefined`.
- `deltaMarker(verdict, now): DeltaMarker | null` — the single display predicate.
  Returns `null` for any verdict that carried usable deltas **and** for `undefined`
  (which, after 3.3, means "not a condor" and nothing else). One predicate, shared by
  the row marker and the banner — same discipline as `isPriceableStructure`.

### 3.3 `app/api/positions/route.ts` — the failure stops vanishing

The roll-annotation `catch` now stamps every unannotated condor with
`noDeltaVerdict(underlying, 'Delta fetch failed: …')` before returning. The isolating
try/catch stays (a `/quotes` hiccup must never take down the monitor) — it just no
longer swallows the fact that it fired. The error text rides into the marker's tooltip;
this is a single-operator app, so surfacing the real message is the useful choice.

After this, `rollVerdict === undefined` on a condor is impossible — collapsing the UI's
two ignorance-cases into one.

### 3.4 `components/positions/PositionsMonitor.tsx`

- `<DeltaMarker>` beside `<RollBadge>` in both renderers (mobile card + desktop row).
- `AlertBanner` gains a `roll alerts stale` clause, counted **in-hours only**, and that
  clause alone is enough to render the banner. The banner is read first; a broken roll
  signal belongs there, not only in a per-row tooltip.

## 4. Non-goals

- No holiday/early-close calendar (§3.1).
- No retry of the failed `/quotes` call. Surfacing ≠ self-healing; a retry loop inside
  the positions route would slow every page load to paper over an outage.
- No change to roll thresholds (30Δ trigger / 27Δ watch), to `computeRollAlert`, or to
  any Schwab write path.
- No new API response fields — the signal rides on the existing per-position
  `rollVerdict`, so neither dashboard fetch site changes.

## 5. Verification

- Unit tests: `market-hours.test.ts` (DST both sides, boundary minutes, weekend,
  ET midnight `h23` guard) and the `deltaMarker` block in `roll-alert.test.ts`.
- Live: the marker is correct-by-construction after the close (`Δ —` on every condor
  once Schwab zeroes greeks — confirm on tonight's monitor). The in-hours amber path is
  the one that can only be confirmed by a real `/quotes` failure; the unit tests pin it.
