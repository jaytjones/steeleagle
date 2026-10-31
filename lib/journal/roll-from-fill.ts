// ============================================================
// SteelEagle — v2.15 Roll-from-Fill mapper (pure — no I/O)
//
// A classified single-ticket ROLL → the journal's roll events, as NUMBERS.
// The write-path twin of `fillToPrefill`'s roll branch, and the roll-side
// mirror of close-from-fill.ts.
//
// ── Why this is not fillToPrefill ──
//
// The pre-fill emits STRINGS and leaves an unknown price as "" for JJ to fill
// in — the right posture for a form a human submits. An automatic write has no
// human to fill the blank, so a null price here REFUSES the whole mapping. A
// write never fabricates a price (v2.11 doctrine); $0.00 is a legal fill price,
// so a defaulted zero would be indistinguishable from a real one.
//
// ── Roles come from the classifier, never from close-from-fill ──
//
// `ClassifiedLeg.role` is the F3 table (`fillLegRole`): on a roll,
// BUY_TO_OPEN is a LONG. close-from-fill's `legRole` (`short = BUY`) is right
// for a pure close and WRONG here — it would invert the new long wing (v2.11
// F3). This module imports nothing from close-from-fill.
//
// ── Direction comes from `creditDebitFor`, the F3 inverse ──
//
// BUY pays, SELL collects — the same function the pre-fill and the inbox's leg
// label use, so the three can never disagree about what a leg was.
// ============================================================

import type { FillClassification } from './classify-fill'
import { creditDebitFor } from './fill-to-draft'
import type { RollEventInput } from './types'

export interface RollFromFillResult {
  /** ISO instant of the fill — one occurredAt across every leg, as RollTradeSchema stamps. */
  occurredAt: string
  /** Closes first, then opens — how currentStructure folds a batch and how JJ reads it. */
  events: RollEventInput[]
  /** Order-level contracts filled. The caller cross-checks against the trade row. */
  contracts: number
}

export function rollInputFromFill(fill: FillClassification): RollFromFillResult {
  const id = fill.orderId

  if (fill.shape !== 'ROLL') {
    throw new Error(`rollInputFromFill: order ${id} is ${fill.shape}, not a single-ticket ROLL`)
  }
  if (!fill.filled || fill.status !== 'FILLED') {
    throw new Error(
      `rollInputFromFill: order ${id} is ${fill.status}${fill.filled ? '' : ' with no executions'} — ` +
        `refusing to journal a roll that did not fully execute`,
    )
  }
  if (fill.refusals.length > 0) {
    throw new Error(`rollInputFromFill: order ${id} carries classifier refusals — ${fill.refusals[0]}`)
  }
  // A ROLL whose legs span two expirations is a roll OUT in time. Same-expiration
  // only (JJ, 2026-10-30 — v2.15 decision 2); `expiration` is null when mixed.
  if (fill.expiration === null) {
    throw new Error(
      `rollInputFromFill: order ${id} spans more than one expiration — a roll out in time ` +
        `is never journaled automatically`,
    )
  }
  if (fill.contracts < 1) {
    throw new Error(`rollInputFromFill: order ${id} reports no filled quantity`)
  }

  const unpriced = fill.legs.find((l) => l.price === null)
  if (unpriced) {
    throw new Error(
      `rollInputFromFill: order ${id} is FILLED but Schwab returned no execution price for ` +
        `${unpriced.occSymbol} — refusing to journal an invented price`,
    )
  }
  // Every leg must have executed the WHOLE ticket. A leg short of the order
  // quantity is a partial, and a partial roll is never written.
  const short = fill.legs.find((l) => l.contracts !== fill.contracts)
  if (short) {
    throw new Error(
      `rollInputFromFill: order ${id} leg ${short.occSymbol} executed ${short.contracts} of ` +
        `${fill.contracts} — partial rolls are never journaled automatically`,
    )
  }

  const events: RollEventInput[] = [...fill.legs]
    .sort((a, b) => (a.action === b.action ? 0 : a.action === 'close' ? -1 : 1))
    .map((l) => ({
      eventType: l.action === 'close' ? ('roll_close' as const) : ('roll_open' as const),
      leg: l.role,
      strike: l.strike,
      expiration: l.expiration,
      delta: null,
      price: l.price as number,
      creditDebit: creditDebitFor(l.action, l.role),
    }))

  return { occurredAt: fill.occurredAt, events, contracts: fill.contracts }
}

/**
 * Do two mappings describe the same roll? null = yes, else the first
 * disagreement in words.
 *
 * The route re-classifies the LIVE order at write time and refuses unless it
 * reproduces the planner's events exactly — strike, role, price, direction and
 * time. The ledger row the planner read was classified on an earlier fetch;
 * if Schwab's record has moved underneath it, the write must not reconcile
 * the difference.
 */
export function rollDisagreement(
  planned: Pick<RollFromFillResult, 'occurredAt' | 'events' | 'contracts'>,
  live: RollFromFillResult,
): string | null {
  if (planned.contracts !== live.contracts) {
    return `contracts: planned ${planned.contracts}, live order ${live.contracts}`
  }
  if (planned.occurredAt !== live.occurredAt) {
    return `time: planned ${planned.occurredAt}, live order ${live.occurredAt}`
  }
  const key = (e: RollEventInput) =>
    `${e.eventType} ${e.leg} ${e.strike} ${e.expiration} ${e.price} ${e.creditDebit}`
  const a = planned.events.map(key)
  const b = live.events.map(key)
  if (a.length !== b.length) return `leg count: planned ${a.length}, live order ${b.length}`
  const i = a.findIndex((k, n) => k !== b[n])
  return i === -1 ? null : `leg ${i + 1}: planned "${a[i]}", live order "${b[i]}"`
}
