// ============================================================
// SteelEagle — v2.11 fill classification (pure — no I/O)
//
// One Schwab order → what lifecycle event it represents. Built against seven
// real payloads pulled 2026-08-14 and pinned in classify-fill.test.ts, per the
// Schwab doctrine: never from the docs.
//
// ── F2. `complexOrderStrategyType` IS NEVER READ ──
//
// The six real rolls came back as `CONDOR` ×5 and `CUSTOM` ×1 — and
// 1007483420023 (`CUSTOM`) is structurally IDENTICAL to 1007454721397
// (`CONDOR`): both are four-leg SPY 2026-09-11 put rolls. Entries and closes
// both come back `IRON_CONDOR`, so the field does not even separate those.
// A classifier keyed on it would silently miss one roll in six.
//
// Shape is derived from `instruction` ALONE. The strategy label is carried
// through untouched for forensics and must never gate a decision. Same trap
// class as `settlementType` meaning AM/PM.
//
// ── F3. The four-instruction role table — do NOT reuse close-from-fill ──
//
// `close-from-fill.ts:31-36` derives the role as `short = startsWith('BUY')`.
// That is correct for a PURE CLOSE, where a bought-back leg must have been
// short, and WRONG for a roll, where `BUY_TO_OPEN` is a long. The full table:
//
//   BUY_TO_CLOSE   was SHORT      → roll_close
//   SELL_TO_CLOSE  was LONG       → roll_close
//   SELL_TO_OPEN   becomes SHORT  → roll_open
//   BUY_TO_OPEN    becomes LONG   → roll_open
//
// i.e. `isShort = (closing && buying) || (opening && selling)`. Reusing the
// close-side helper here would map a roll's new long wing to a short role and
// produce a journal entry that inverts two legs.
//
// ── Status independence ──
//
// Shape is classified for ANY order, filled or not. A REJECTED order still has
// a shape, and the GLD streak (Aug 3–13 2026: nine rejected closes on legs
// rolled away twice) is the strongest journal-drift signal the account emits.
// v2.11's inbox is meant to surface those, so refusing to classify them here
// would throw the signal away. Prices are null when nothing executed; the
// journaling step demands them, this step does not.
// ============================================================

import { parseOccSymbol } from '../strategy/reconstruct-positions'
import type { SchwabOrderDetail } from '../schwab/orders'
import type { Leg } from './types'

export type FillShape =
  /** 4 legs, all opening, 2 puts + 2 calls, LP < SP <= SC < LC. */
  | 'CONDOR_OPEN'
  /** 4 legs, all closing, 2 puts + 2 calls, LP < SP <= SC < LC. */
  | 'CONDOR_CLOSE'
  /** Opening AND closing legs in ONE ticket. The single-ticket roll (F1). */
  | 'ROLL'
  /** All opening, but not a four-leg condor — e.g. one side of a split roll. */
  | 'PARTIAL_OPEN'
  /** All closing, but not a four-leg condor — e.g. the other side of one. */
  | 'PARTIAL_CLOSE'
  /** No option legs at all (equity, cash). Not a condor lifecycle event. */
  | 'NOT_OPTION'
  /** Option legs present but the shape is not one we will act on. */
  | 'AMBIGUOUS'

export interface ClassifiedLeg {
  occSymbol: string
  root: string
  underlying: string
  expiration: string
  strike: number
  putCall: 'PUT' | 'CALL'
  /** 'open' = position acquired · 'close' = position retired. */
  action: 'open' | 'close'
  /** Journal leg role, per the F3 table above. */
  role: Leg
  /** Contracts actually executed; falls back to the requested quantity. */
  contracts: number
  /** Quantity-weighted average execution price, or null when nothing executed. */
  price: number | null
}

export interface FillClassification {
  orderId: string
  shape: FillShape
  /** Raw Schwab status, uppercased. 'UNKNOWN' when absent. */
  status: string
  /** Carried for forensics ONLY. Never gates a decision — see F2. */
  complexOrderStrategyType: string | null
  orderType: string | null
  /** Net ticket price as Schwab recorded it. Cross-check, never a substitute. */
  netPrice: number | null
  /** Shared by every option leg, else null (a diagonal spans expirations). */
  underlying: string | null
  expiration: string | null
  enteredTime: string
  /** Latest execution time, else closeTime, else enteredTime. */
  occurredAt: string
  /** Order-level contracts filled. 0 when nothing executed. */
  contracts: number
  /** True when at least one execution leg exists. */
  filled: boolean
  legs: ClassifiedLeg[]
  /** Why the shape is AMBIGUOUS, or any per-leg problem. Always populated on refusal. */
  refusals: string[]
}

const OPENING = '_TO_OPEN'
const CLOSING = '_TO_CLOSE'

/**
 * The F3 table. Exported so tests can pin all four rows directly, and so no
 * future caller re-derives it from `startsWith('BUY')`.
 */
export function fillLegRole(instruction: string, putCall: 'PUT' | 'CALL'): Leg {
  const closing = instruction.endsWith(CLOSING)
  const buying = instruction.startsWith('BUY')
  const short = closing ? buying : !buying
  if (putCall === 'PUT') return short ? 'short_put' : 'long_put'
  return short ? 'short_call' : 'long_call'
}

/** legId → quantity-weighted average price and executed quantity. */
function executionsByLeg(order: SchwabOrderDetail): Map<number, { price: number; qty: number }> {
  const acc = new Map<number, { paid: number; qty: number }>()
  for (const activity of order.orderActivityCollection ?? []) {
    for (const exec of activity.executionLegs ?? []) {
      const q = exec.quantity ?? 1
      const prev = acc.get(exec.legId) ?? { paid: 0, qty: 0 }
      acc.set(exec.legId, { paid: prev.paid + exec.price * q, qty: prev.qty + q })
    }
  }
  const out = new Map<number, { price: number; qty: number }>()
  for (const [legId, { paid, qty }] of acc) {
    out.set(legId, { price: qty > 0 ? paid / qty : 0, qty })
  }
  return out
}

function latestExecutionTime(order: SchwabOrderDetail): string | null {
  let latest: string | null = null
  for (const activity of order.orderActivityCollection ?? []) {
    for (const exec of activity.executionLegs ?? []) {
      if (exec.time && (latest === null || exec.time > latest)) latest = exec.time
    }
  }
  return latest
}

/** Unique value across a list, or null when absent or mixed. */
function soleValue<T>(values: readonly T[]): T | null {
  if (values.length === 0) return null
  const first = values[0]
  return values.every((v) => v === first) ? first : null
}

/**
 * Is this leg set a well-formed four-leg condor (or butterfly)?
 *
 * The invariant is the v2.7 one, unchanged: **LP < SP <= SC < LC**. The `<=`
 * admits the butterfly's zero-width body — pinned live by the SPY 2026-08-28
 * close, orderId 1007514529392, at 745/765/765/785. `SP > SC` is never valid.
 */
function isCondorShape(legs: readonly ClassifiedLeg[]): boolean {
  if (legs.length !== 4) return false
  const at = (role: Leg) => legs.filter((l) => l.role === role)
  const lp = at('long_put')
  const sp = at('short_put')
  const sc = at('short_call')
  const lc = at('long_call')
  if (lp.length !== 1 || sp.length !== 1 || sc.length !== 1 || lc.length !== 1) return false
  return (
    lp[0].strike < sp[0].strike &&
    sp[0].strike <= sc[0].strike &&
    sc[0].strike < lc[0].strike
  )
}

/**
 * Classify one Schwab order. Never throws — a malformed order is classified
 * AMBIGUOUS with the reason recorded, so one bad order in a day's fetch cannot
 * abort the batch.
 */
export function classifyFill(order: SchwabOrderDetail): FillClassification {
  const orderId = String(order.orderId)
  const refusals: string[] = []
  const execs = executionsByLeg(order)

  const legs: ClassifiedLeg[] = []
  let sawNonOption = false

  ;(order.orderLegCollection ?? []).forEach((raw, idx) => {
    if (raw.instrument?.assetType !== 'OPTION') {
      sawNonOption = true
      return
    }
    const instruction = raw.instruction ?? ''
    const opening = instruction.endsWith(OPENING)
    const closing = instruction.endsWith(CLOSING)
    if (!opening && !closing) {
      refusals.push(
        `order ${orderId}: leg ${raw.instrument.symbol} has instruction "${instruction || '(none)'}" — ` +
          `neither opening nor closing`,
      )
      return
    }

    const parsed = parseOccSymbol(raw.instrument.symbol)
    if (!parsed) {
      refusals.push(`order ${orderId}: unparseable OCC symbol "${raw.instrument.symbol}"`)
      return
    }

    const legId = raw.legId ?? idx + 1
    const exec = execs.get(legId)

    legs.push({
      occSymbol: raw.instrument.symbol,
      root: parsed.root,
      underlying: parsed.underlying,
      expiration: parsed.expiration,
      strike: parsed.strike,
      putCall: parsed.putCall,
      action: opening ? 'open' : 'close',
      role: fillLegRole(instruction, parsed.putCall),
      contracts: exec?.qty ?? raw.quantity ?? 0,
      price: exec ? exec.price : null,
    })
  })

  const filled = execs.size > 0
  const occurredAt =
    latestExecutionTime(order) ?? order.closeTime ?? order.enteredTime

  const base = {
    orderId,
    status: (order.status ?? 'UNKNOWN').toUpperCase(),
    complexOrderStrategyType: order.complexOrderStrategyType ?? null,
    orderType: order.orderType ?? null,
    netPrice: order.price ?? null,
    underlying: soleValue(legs.map((l) => l.underlying)),
    expiration: soleValue(legs.map((l) => l.expiration)),
    enteredTime: order.enteredTime,
    occurredAt: new Date(occurredAt).toISOString(),
    contracts: order.filledQuantity ?? 0,
    filled,
    legs,
    refusals,
  }

  if (legs.length === 0) {
    return {
      ...base,
      shape: sawNonOption || refusals.length === 0 ? 'NOT_OPTION' : 'AMBIGUOUS',
    }
  }

  // A leg we could not read means the shape we DID read is a partial view of
  // the ticket. Never classify from an incomplete leg set.
  if (refusals.length > 0) return { ...base, shape: 'AMBIGUOUS' }

  const opens = legs.filter((l) => l.action === 'open')
  const closes = legs.filter((l) => l.action === 'close')

  // ---- ROLL: both directions in one ticket (F1) ----
  if (opens.length > 0 && closes.length > 0) {
    // Roles must be unique WITHIN a direction, not across it — a roll legitimately
    // touches short_put twice, once closing and once opening. That asymmetry is
    // exactly what RollTradeSchema's superRefine encodes.
    const dup = (side: ClassifiedLeg[]) =>
      new Set(side.map((l) => l.role)).size !== side.length
    if (dup(opens) || dup(closes)) {
      return {
        ...base,
        shape: 'AMBIGUOUS',
        refusals: [
          `order ${orderId}: a roll side maps two legs to the same role — cannot tell which ` +
            `leg replaced which, refusing to classify`,
        ],
      }
    }
    // A roll_open with no matching roll_close on the same role would overwrite a
    // live leg with no record of the old one — refused at journal entry, so it
    // must be refused here rather than proposed and rejected downstream.
    const closedRoles = new Set(closes.map((l) => l.role))
    const orphan = opens.find((l) => !closedRoles.has(l.role))
    if (orphan) {
      return {
        ...base,
        shape: 'AMBIGUOUS',
        refusals: [
          `order ${orderId}: opens ${orphan.role} without closing it in the same ticket — ` +
            `journaling this would overwrite a live leg`,
        ],
      }
    }
    return { ...base, shape: 'ROLL' }
  }

  // ---- Single-direction tickets ----
  const allOpen = closes.length === 0
  if (isCondorShape(legs)) {
    return { ...base, shape: allOpen ? 'CONDOR_OPEN' : 'CONDOR_CLOSE' }
  }

  // Four legs that are NOT a clean condor is a different animal from two legs
  // that were never meant to be one — the first is a malformed condor and gets
  // an explicit refusal, the second is simply one side of a split roll.
  if (legs.length === 4) {
    return {
      ...base,
      shape: 'AMBIGUOUS',
      refusals: [
        `order ${orderId}: four ${allOpen ? 'opening' : 'closing'} legs that are not a condor — ` +
          `roles must be one of each with LP < SP <= SC < LC`,
      ],
    }
  }

  return { ...base, shape: allOpen ? 'PARTIAL_OPEN' : 'PARTIAL_CLOSE' }
}

/** True for the shapes that represent a real condor lifecycle event. */
export function isLifecycleShape(shape: FillShape): boolean {
  return (
    shape === 'CONDOR_OPEN' ||
    shape === 'CONDOR_CLOSE' ||
    shape === 'ROLL' ||
    shape === 'PARTIAL_OPEN' ||
    shape === 'PARTIAL_CLOSE'
  )
}
