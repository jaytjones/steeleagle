// ============================================================
// SteelEagle — did this order activity actually MOVE contracts? (pure — no I/O)
//
// ONE predicate, shared by every consumer of `orderActivityCollection`. It
// exists because the collection's name is a lie: Schwab files a CANCELLATION
// in it as an `activityType: "EXECUTION"` with `executionType: "CANCELED"`,
// carrying full `executionLegs` at the ORDER's quantity and `price: 0`.
//
// Live payload, order 1007540494945 — a sweep-placed SPY 2026-09-11 exit GTC
// that JJ cancelled in TOS on 2026-08-14 to roll the position instead:
//
//   status:         "CANCELED"
//   filledQuantity: 0
//   orderActivityCollection: [{
//     activityType:  "EXECUTION",
//     executionType: "CANCELED",
//     executionLegs: [ {legId:1, quantity:1, price:0}, ... x4 ]
//   }]
//
// Nothing traded. Four legs at quantity 1 say otherwise to anything that reads
// `executionLegs` alone. Pinned as `SPY_CANCELED_GTC` in golden-fills.fixture.ts.
//
// ── Why quantity and price are NOT reliable discriminators ──
//
// Session 22 met the same class and guarded it with "skip zero-quantity
// executions" (classify-fill.ts), on the evidence of three orders whose cancel
// records carried quantity 0. That premise does not hold: of the 22 CANCELED
// and 22 REPLACED activities standing in the live 180-day window on 2026-08-20,
// every one carries a NON-ZERO leg quantity (1, 2 or 5). Price is 0 across all
// of them, but a real fill can also print at 0 on a worthless leg — the
// importer already relies on that being possible. `executionType` is the only
// field that says what the record IS.
//
// ── The scan behind the three values ──
//
// Every activity in the live 180-day window on 2026-08-20 (100 across 123
// orders), by (status, activityType, executionType):
//
//   56x  FILLED    EXECUTION  FILL       real quantities, real prices
//   22x  CANCELED  EXECUTION  CANCELED   quantity 1/2,   price 0
//   22x  REPLACED  EXECUTION  CANCELED   quantity 1/2/5, price 0
//
// `executionType` was present on all 100. REJECTED, EXPIRED and
// PENDING_ACTIVATION orders carry no activity collection at all — which is why
// a rejected order was always harmless, and why the surrounding code's belief
// that reading executions is "status-independent" survived as long as it did.
//
// REPLACED is the dangerous half. A replaced order's cancel record repeats the
// very legs its replacement then fills, so the phantom does not look like
// noise — it DOUBLES the real movement. On the 2026-08-14 split-roll morning
// the identity would have read GLD 395/385/375/365 at ±4 where ±2 traded.
//
// ── Why UNKNOWN is a third value and not folded into either ──
//
// A label we do not recognise is neither a known movement nor a known zero,
// and the two callers want opposite things from that:
//
//   - `orderEffect` is building a PROOF. It refuses, and the interval goes
//     UNRELIABLE — the honest state for "I cannot tell what this record was".
//   - the classification/price paths are building a PROPOSAL for JJ, already
//     behind their own refuse-don't-guess gates. They keep reading it, exactly
//     as they did before this module existed.
//
// Collapsing UNKNOWN into NONE would let a future Schwab label silently delete
// real contracts from the identity, which is the failure this file prevents in
// the other direction. Callers decide; the predicate only reports.
// ============================================================

import type { SchwabOrderActivity } from './orders'

export type ExecutionScope =
  /** Contracts really changed hands. Sign it, price it, journal it. */
  | 'FILL'
  /** Present and definitively moved nothing: a cancellation or a replacement. */
  | 'NONE'
  /** Absent or unrecognised label. In scope but unknown — never a silent zero. */
  | 'UNKNOWN'

/** Schwab's label for a record that moved contracts. */
const FILL = 'FILL'
/** Schwab's label for a cancellation, on CANCELED and REPLACED orders alike. */
const CANCELED = 'CANCELED'

/**
 * What one `orderActivityCollection` entry actually did to the account.
 *
 * Case-insensitive on the label only. An activity with no `executionType` is
 * UNKNOWN rather than assumed to be a fill: it has never once appeared on a
 * live payload, so this branch is dormant by construction, and a dormant
 * honest branch beats an assumption that is only usually right.
 */
export function executionScope(activity: SchwabOrderActivity): ExecutionScope {
  const label = (activity.executionType ?? '').toUpperCase()
  if (label === FILL) return 'FILL'
  if (label === CANCELED) return 'NONE'
  return 'UNKNOWN'
}

/**
 * Convenience for the proposal-side callers: did this activity definitively
 * move nothing? True ONLY for an explicit cancellation — an UNKNOWN activity
 * is still read, preserving pre-existing behaviour on payloads that predate
 * the field.
 */
export function movedNothing(activity: SchwabOrderActivity): boolean {
  return executionScope(activity) === 'NONE'
}
