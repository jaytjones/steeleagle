// ============================================================
// SteelEagle — v2.2 Close-from-Fill mapper (pure — no I/O)
//
// Maps a FILLED Schwab GTC exit order to the journal's CloseTradeInput
// (the reconcile write in the exit sweep, spec §4.3a). Refusal
// semantics are IDENTICAL to recordFillAction on the entry side:
//   - status must be FILLED, exactly 4 legs, fully filled quantity
//   - every leg must be a *_TO_CLOSE instruction (it's an exit)
//   - every leg must have real execution detail — prices are NEVER
//     fabricated; a missing execution leg refuses the whole mapping
//     (the sweep flags it; the manual Close form is the fallback)
//
// Direction convention on a close: BUY_TO_CLOSE pays (debit),
// SELL_TO_CLOSE collects (credit) — the mirror of entry.
// ============================================================

import type { CloseTradeInput, Leg } from './types'
import type { SchwabOrderDetail } from '../schwab/orders'
import { parseOccSymbol } from '../strategy/reconstruct-positions'

export interface CloseFromFillResult {
  /** ISO timestamp of the fill (Schwab closeTime, else latest execution time). */
  occurredAt: string
  /** Ready for CloseTradeSchema / closeTrade — closeReason is the caller's. */
  events: CloseTradeInput['events']
  /** Contracts confirmed filled — the caller cross-checks against the trade row. */
  contracts: number
}

/** instruction + putCall → journal leg name (same table as the entry side). */
function legRole(instruction: string, putCall: 'PUT' | 'CALL'): Leg {
  // On a CLOSE, buying back = the leg was SHORT; selling out = it was LONG.
  const short = instruction.startsWith('BUY')
  if (putCall === 'PUT') return short ? 'short_put' : 'long_put'
  return short ? 'short_call' : 'long_call'
}

export function closeInputFromFilledExit(order: SchwabOrderDetail): CloseFromFillResult {
  const orderId = String(order.orderId)

  if (order.status !== 'FILLED') {
    throw new Error(
      `closeInputFromFilledExit: order ${orderId} is ${order.status ?? 'UNKNOWN'}, not FILLED — refusing to journal a close`,
    )
  }

  const legsRaw = order.orderLegCollection ?? []
  if (legsRaw.length !== 4) {
    throw new Error(
      `closeInputFromFilledExit: order ${orderId} has ${legsRaw.length} legs — expected a 4-leg condor close`,
    )
  }
  const nonClose = legsRaw.find((l) => !(l.instruction ?? '').endsWith('_TO_CLOSE'))
  if (nonClose) {
    throw new Error(
      `closeInputFromFilledExit: order ${orderId} leg ${nonClose.instrument.symbol} is ` +
        `${nonClose.instruction} — not a pure closing order, refusing`,
    )
  }

  const filledQty = order.filledQuantity ?? 0
  const orderQty = order.quantity ?? 0
  if (orderQty > 0 && filledQty !== orderQty) {
    throw new Error(
      `closeInputFromFilledExit: order ${orderId} filled ${filledQty}/${orderQty} — ` +
        `partial fills are never journaled automatically`,
    )
  }
  const contracts = filledQty || orderQty
  if (contracts < 1) {
    throw new Error(
      `closeInputFromFilledExit: order ${orderId} reports no filled quantity — refusing`,
    )
  }

  // Per-leg fill prices: quantity-weighted average across execution
  // activities, keyed by legId — identical to the entry-side mapping.
  const fills = new Map<number, { paid: number; qty: number }>()
  let latestExecTime: string | null = null
  for (const activity of order.orderActivityCollection ?? []) {
    for (const ex of activity.executionLegs ?? []) {
      const q = ex.quantity ?? 1
      const prev = fills.get(ex.legId) ?? { paid: 0, qty: 0 }
      fills.set(ex.legId, { paid: prev.paid + ex.price * q, qty: prev.qty + q })
      if (ex.time && (latestExecTime === null || ex.time > latestExecTime)) {
        latestExecTime = ex.time
      }
    }
  }

  const seenRoles = new Set<Leg>()
  const events: CloseTradeInput['events'] = legsRaw.map((raw) => {
    const parsed = parseOccSymbol(raw.instrument.symbol)
    if (!parsed) {
      throw new Error(
        `closeInputFromFilledExit: order ${orderId} has unparseable OCC symbol "${raw.instrument.symbol}"`,
      )
    }
    const role = legRole(raw.instruction, parsed.putCall)
    if (seenRoles.has(role)) {
      throw new Error(
        `closeInputFromFilledExit: order ${orderId} maps two legs to ${role} — not a clean condor close, refusing`,
      )
    }
    seenRoles.add(role)

    const fill = raw.legId !== undefined ? fills.get(raw.legId) : undefined
    if (!fill || fill.qty <= 0) {
      // Never fabricate a close price. The sweep flags; the operator
      // journals via the Close form with real TOS numbers.
      throw new Error(
        `closeInputFromFilledExit: order ${orderId} is FILLED but Schwab returned no ` +
          `execution detail for leg ${raw.instrument.symbol} — refusing to journal invented prices`,
      )
    }

    return {
      eventType: 'close' as const,
      leg: role,
      strike: parsed.strike,
      expiration: parsed.expiration,
      delta: null,
      price: fill.paid / fill.qty,
      creditDebit: raw.instruction.startsWith('BUY') ? ('debit' as const) : ('credit' as const),
    }
  })

  const occurredAt = order.closeTime ?? latestExecTime ?? order.enteredTime
  return { occurredAt: new Date(occurredAt).toISOString(), events, contracts }
}
