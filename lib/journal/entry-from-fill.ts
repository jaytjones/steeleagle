// ============================================================
// SteelEagle — v2.16 Entry-from-Fill mapper (pure — no I/O)
//
// A classified four-leg ENTRY → the journal's NewTradeInput, as numbers.
// Spec: docs/steeleagle-v2-16-spec.md §2.
//
// ── What made this possible ──
//
// v2.11 §8.2 and v2.14 both said entries were un-journalable automatically
// because `initialBpr` is not in the order payload and `enteredBpr` refuses 0.
// Session 27 made BPR DERIVED from the legs (`entryBpr`), so that reason is
// gone. `entryBpr` returns null rather than guess (a leg unpriced, or a result
// ≤ 0) — and null REFUSES here. Never `recordFillAction`'s 0.01 floor: a floor
// is a fabricated number that reads like a real one.
//
// ── What this does not carry, deliberately ──
//
// `delta` is null: Schwab's order payload has no greeks. Zero of the 23 trades
// in the journal on 2026-10-31 record an entry delta, so nothing recorded
// today is lost.
//
// ── Butterflies refuse ──
//
// The app must never OPEN a butterfly, and Schwab's ENTRY payload for one is
// unpinned (v2.7.1 pinned the CLOSE only). An SP == SC entry made in TOS stays
// a hand journal entry.
// ============================================================

import type { FillClassification } from './classify-fill'
import { creditDebitFor } from './fill-to-draft'
import { entryBpr } from './trade-math'
import type { LegInput, NewTradeInput } from './types'

export function entryInputFromFill(fill: FillClassification, notes: string): NewTradeInput {
  const id = fill.orderId

  if (fill.shape !== 'CONDOR_OPEN') {
    throw new Error(`entryInputFromFill: order ${id} is ${fill.shape}, not a four-leg entry`)
  }
  if (!fill.filled || fill.status !== 'FILLED') {
    throw new Error(
      `entryInputFromFill: order ${id} is ${fill.status} — refusing to journal an entry that ` +
        `did not fully execute`,
    )
  }
  if (fill.refusals.length > 0) {
    throw new Error(`entryInputFromFill: order ${id} carries classifier refusals — ${fill.refusals[0]}`)
  }
  if (fill.underlying === null || fill.expiration === null) {
    throw new Error(`entryInputFromFill: order ${id} does not share one underlying and expiration`)
  }
  if (fill.contracts < 1) {
    throw new Error(`entryInputFromFill: order ${id} reports no filled quantity`)
  }
  const unpriced = fill.legs.find((l) => l.price === null)
  if (unpriced) {
    throw new Error(
      `entryInputFromFill: order ${id} is FILLED but Schwab returned no execution price for ` +
        `${unpriced.occSymbol} — refusing to journal an invented price`,
    )
  }
  const short = fill.legs.find((l) => l.contracts !== fill.contracts)
  if (short) {
    throw new Error(
      `entryInputFromFill: order ${id} leg ${short.occSymbol} executed ${short.contracts} of ` +
        `${fill.contracts} — partial entries are never journaled automatically`,
    )
  }

  const strike = (role: LegInput['leg']) => fill.legs.find((l) => l.role === role)!.strike
  if (strike('short_put') === strike('short_call')) {
    throw new Error(
      `entryInputFromFill: order ${id} opens a butterfly (SP == SC) — the app never journals ` +
        `a butterfly ENTRY automatically; its entry payload is unpinned (v2.7.1)`,
    )
  }

  const legs: LegInput[] = fill.legs.map((l) => ({
    leg: l.role,
    strike: l.strike,
    expiration: l.expiration,
    delta: null,
    price: l.price as number,
    creditDebit: creditDebitFor('open', l.role),
  }))

  const initialBpr = entryBpr(legs, fill.contracts)
  if (initialBpr === null) {
    throw new Error(
      `entryInputFromFill: order ${id} — buying-power reduction could not be derived ` +
        `(wing width minus net credit is not positive); never journaled with a guessed BPR`,
    )
  }

  return {
    symbol: fill.underlying,
    sleeve: 'core',
    openedAt: fill.occurredAt,
    initialExpiration: fill.expiration,
    contracts: fill.contracts,
    initialBpr,
    notes,
    source: 'schwab_fill',
    schwabOrderId: id,
    legs,
  }
}

/**
 * Do two mappings describe the same entry? null = yes, else the first
 * disagreement. The route re-maps the LIVE order at write time and refuses
 * unless it reproduces the planner's input exactly.
 */
export function entryDisagreement(planned: NewTradeInput, live: NewTradeInput): string | null {
  const scalar = ['symbol', 'openedAt', 'initialExpiration', 'contracts', 'initialBpr'] as const
  for (const k of scalar) {
    if (planned[k] !== live[k]) return `${k}: planned ${planned[k]}, live order ${live[k]}`
  }
  const key = (l: LegInput) => `${l.leg} ${l.strike} ${l.expiration} ${l.price} ${l.creditDebit}`
  const a = [...planned.legs].map(key).sort()
  const b = [...live.legs].map(key).sort()
  const i = a.findIndex((k, n) => k !== b[n])
  return i === -1 && a.length === b.length ? null : `legs: planned "${a[i]}", live order "${b[i]}"`
}
