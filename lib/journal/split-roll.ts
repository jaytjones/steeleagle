// ============================================================
// SteelEagle — v2.16 split-roll pairing, PREFILL ONLY (pure — no I/O)
//
// A split roll is two tickets — the old spread closed, the new one opened —
// that say nothing about being a roll (live: SPY 2026-09-11, 2026-08-14,
// VERTICAL 1007598808689 + 1007598809002, 4m28s apart). Until now each half
// opened its own Roll form with "add the partner ticket's legs before saving",
// and the OPEN half could not open one at all: it closes nothing, so it has no
// owning trade to attach a form to.
//
// SCOPE, decided by JJ 2026-10-31: PREFILL ONLY. This pairs the halves into
// ONE Roll form for JJ to confirm. It never writes. Automatic pairing stays
// deferred — one split roll in 180 days does not earn the least-proven
// heuristic of the three. Because a human confirms every pairing, the rules
// below are about never pairing WRONGLY, not about pairing everything.
//
// ── The pairing rule ──
//
// The other half is a fill of the OPPOSITE partial shape with the same
// underlying, expiration and contract count, inside SPLIT_ROLL_WINDOW_MIN,
// where every leg of both tickets is one putCall and the roles closed are
// exactly the roles opened. EXACTLY ONE such fill, or no pairing — a second
// candidate is ambiguity, and the card falls back to its unpaired form.
// Either ticket may come first: a human confirms, so open-then-close does not
// need refusing here.
// ============================================================

import type { FillClassification } from './classify-fill'
import { creditDebitFor, type FillPrefill } from './fill-to-draft'

/** Max gap between the two tickets. Live: 4 min 28 s. */
export const SPLIT_ROLL_WINDOW_MIN = 30

export type SplitPairing =
  | { partner: FillClassification; reason: null }
  | { partner: null; reason: string }

const isHalf = (f: FillClassification) =>
  (f.shape === 'PARTIAL_CLOSE' || f.shape === 'PARTIAL_OPEN') &&
  f.filled &&
  f.status === 'FILLED' &&
  f.refusals.length === 0

const roles = (f: FillClassification) => [...new Set(f.legs.map((l) => l.role))].sort().join(',')

export function pairSplitRoll(
  fill: FillClassification,
  others: readonly FillClassification[],
): SplitPairing {
  if (!isHalf(fill)) return { partner: null, reason: 'not a filled split-roll half' }
  const want = fill.shape === 'PARTIAL_CLOSE' ? 'PARTIAL_OPEN' : 'PARTIAL_CLOSE'
  const sides = new Set(fill.legs.map((l) => l.putCall))
  if (sides.size !== 1) return { partner: null, reason: 'this ticket mixes puts and calls' }
  const at = Date.parse(fill.occurredAt)

  const candidates = others.filter(
    (o) =>
      o.orderId !== fill.orderId &&
      isHalf(o) &&
      o.shape === want &&
      o.underlying === fill.underlying &&
      o.expiration === fill.expiration &&
      o.contracts === fill.contracts &&
      Math.abs(Date.parse(o.occurredAt) - at) <= SPLIT_ROLL_WINDOW_MIN * 60_000 &&
      o.legs.every((l) => sides.has(l.putCall)) &&
      roles(o) === roles(fill),
  )

  if (candidates.length === 1) return { partner: candidates[0], reason: null }
  if (candidates.length === 0) {
    return {
      partner: null,
      reason: `no matching partner ticket within ${SPLIT_ROLL_WINDOW_MIN} minutes`,
    }
  }
  return {
    partner: null,
    reason: `${candidates.length} possible partner tickets — not pairing; journal by hand`,
  }
}

/**
 * One Roll-form pre-fill from both halves. Strings and "" for an unknown price
 * — the fill-to-draft posture, never a fabricated zero. One occurredAt for the
 * whole roll (the fold batches on it): the LATER ticket, when the roll was
 * complete.
 */
export function splitRollToPrefill(a: FillClassification, b: FillClassification): FillPrefill {
  const [close, open] = a.shape === 'PARTIAL_CLOSE' ? [a, b] : [b, a]
  const occurredAt = close.occurredAt > open.occurredAt ? close.occurredAt : open.occurredAt
  const legs = [...close.legs, ...open.legs]
  return {
    mode: 'roll',
    occurredAt,
    notes:
      `Journaled from a SPLIT roll — Schwab orders ${close.orderId} (close) + ` +
      `${open.orderId} (open).`,
    rows: legs.map((l) => ({
      eventType: l.action === 'close' ? ('roll_close' as const) : ('roll_open' as const),
      leg: l.role,
      strike: String(l.strike),
      expiration: l.expiration,
      delta: '',
      price: l.price === null ? '' : l.price.toFixed(2),
      creditDebit: creditDebitFor(l.action, l.role),
    })),
    hasMissingPrices: legs.some((l) => l.price === null),
  }
}
