// ============================================================
// SteelEagle — v2.11 order effects (pure — no I/O)
//
// The RIGHT side of April's accounting identity (spec §2): what the orders in
// an interval SHOULD have done to the account's option positions.
//
// ── The sign rule, and why there is no open/close case analysis ──
//
//   BUY_TO_OPEN    +q   acquire a long
//   BUY_TO_CLOSE   +q   retire a short   → signed quantity still RISES
//   SELL_TO_OPEN   −q   acquire a short
//   SELL_TO_CLOSE  −q   retire a long    → signed quantity still FALLS
//
// So the effect is simply: BUY is +q, SELL is −q, and the _TO_OPEN / _TO_CLOSE
// half of the instruction is IRRELEVANT to position arithmetic. It matters
// enormously for classification (see classify-fill.ts F3) and not at all here.
// Keeping that distinction straight is the whole reason these are two modules.
//
// ── Effects come from EXECUTIONS, never from the order's leg quantities ──
//
// `orderLegCollection[].quantity` is what was ASKED FOR.
// `orderActivityCollection[].executionLegs[].quantity` is what HAPPENED.
//
// Using the request would credit a WORKING, REJECTED or CANCELED order with a
// position change it never made — and the GLD rejection streak (Aug 3–13 2026)
// is exactly that scenario, nine orders that asked for a close and moved
// nothing. Reading executions makes this module STATUS-INDEPENDENT: a rejected
// order contributes nothing because it executed nothing, with no status table
// to keep in sync. That is deliberate, and it is the same lesson as F2 — do not
// trust a Schwab label when the underlying facts are available.
//
// A partially filled order therefore contributes its PARTIAL effect, which is
// correct: those contracts really did change hands.
//
// ── Scope: this is an OPTION-leg identity, on BOTH sides ──
//
// `positionsToQty` skips every non-OPTION position on the LEFT side, so the
// right side must skip every non-OPTION leg too. A MUTUAL_FUND cash sweep is
// not an unknown quantity — it is OUT OF SCOPE, exactly as the mutual fund
// holding it produces is out of scope in the snapshot. Its contribution is a
// known zero.
//
// This distinction was a live defect (2026-08-20). Non-option legs were never
// entered into `legById` at all, so their executions matched nothing and fell
// through to the refusal branch below — and five SWVXX money-market orders
// standing in the 180-day window made EVERY interval UNRELIABLE on the first
// two real cron runs of v2.11 (Aug 18 and Aug 19). Schwab's sweep fund trades
// continuously, so this was not a transient: the accounting identity could
// never have balanced, and v2.11 step 8's auto-write gate is bounded by
// exactly that proof. See SWVXX_CASH_SWEEP in golden-fills.fixture.ts.
//
// ── Refusals ──
//
// A refusal means IN SCOPE BUT UNKNOWN, and it must never mean out of scope.
// An execution leg whose legId is absent from orderLegCollection ENTIRELY
// cannot be signed — we know contracts moved but not in which direction. That
// is recorded as a refusal rather than skipped, because a silently dropped
// effect shows up downstream as a residual blamed on the ACCOUNT when the
// fault is ours. An interval containing any refusal is UNRELIABLE, never
// merely unbalanced — so widening what counts as a refusal is not a safe
// default. It disarms the proof it was meant to protect.
// ============================================================

import type { SchwabOrderDetail } from '../schwab/orders'
import type { SymbolQty } from './position-delta'
import { addQty } from './position-delta'

export interface OrderEffect {
  orderId: string
  /** occSymbol → signed contract change actually executed. Empty = nothing filled. */
  symbols: SymbolQty
  /**
   * Non-empty = this order's effect is NOT fully known. Never treat an effect
   * carrying refusals as zero; propagate it (see balance.ts `UNRELIABLE`).
   */
  refusals: string[]
}

/** True for BUY_TO_OPEN / BUY_TO_CLOSE; false for the SELL pair. */
function isBuy(instruction: string): boolean {
  return instruction.startsWith('BUY')
}

/**
 * An interval, half-open as `(from, to]`.
 *
 * Executions are filtered INDIVIDUALLY, not whole orders. Filtering by order
 * would double-count a fill that straddles a snapshot boundary: a GTC that
 * partially filled yesterday and completed today is ONE order whose earlier
 * contracts are already baked into the anchor snapshot. Counting the whole
 * order against today's delta would leave a phantom residual on both days.
 */
export interface ExecutionWindow {
  from: Date
  to: Date
}

/**
 * The signed position change a single order actually executed.
 *
 * With a `window`, only executions timestamped inside it count. An execution
 * with NO timestamp cannot be placed in time, so it becomes a refusal rather
 * than being silently included or silently dropped — either choice would be a
 * guess, and both fail in the direction of a residual blamed on the account.
 *
 * Never throws — a malformed order yields refusals, so one bad order in a
 * day's fetch cannot abort the interval's arithmetic.
 */
export function orderEffect(
  order: SchwabOrderDetail,
  window?: ExecutionWindow,
): OrderEffect {
  const orderId = String(order.orderId)
  const symbols = new Map<string, number>()
  const refusals: string[] = []

  // legId → what the request said this leg was. EVERY leg is recorded, option
  // or not: a leg that is present-but-out-of-scope must be distinguishable
  // from a leg that is absent, or the two collapse and a cash sweep reads as
  // an unknown contract movement.
  type KnownLeg =
    | { inScope: true; symbol: string; buy: boolean }
    | { inScope: false }
  const legById = new Map<number, KnownLeg>()
  ;(order.orderLegCollection ?? []).forEach((leg, idx) => {
    // Schwab legIds are 1-based; fall back to position, as the importer does.
    const legId = leg.legId ?? idx + 1

    if (leg.instrument?.assetType !== 'OPTION') {
      legById.set(legId, { inScope: false })
      return
    }
    const instruction = leg.instruction ?? ''
    if (!instruction) {
      // In scope and genuinely unsignable — this one IS a refusal.
      refusals.push(`order ${orderId}: leg ${leg.instrument?.symbol ?? '?'} has no instruction`)
      return
    }
    legById.set(legId, {
      inScope: true,
      symbol: leg.instrument.symbol,
      buy: isBuy(instruction),
    })
  })

  for (const activity of order.orderActivityCollection ?? []) {
    for (const exec of activity.executionLegs ?? []) {
      const leg = legById.get(exec.legId)
      if (!leg) {
        refusals.push(
          `order ${orderId}: execution leg ${exec.legId} has no matching order leg — ` +
            `contracts moved but the direction is unknown`,
        )
        continue
      }

      // Out of scope, not unknown: a known zero on an identity that only ever
      // covered option legs. Checked BEFORE the window, since an out-of-scope
      // execution contributes nothing whether it lands in the interval or not
      // — and a mutual fund settles days late, so it often straddles one.
      if (!leg.inScope) continue

      if (window) {
        if (!exec.time) {
          refusals.push(
            `order ${orderId}: execution leg ${exec.legId} has no timestamp — ` +
              `cannot tell whether it falls inside the interval`,
          )
          continue
        }
        const at = Date.parse(exec.time)
        if (Number.isNaN(at)) {
          refusals.push(
            `order ${orderId}: execution leg ${exec.legId} has an unparseable timestamp "${exec.time}"`,
          )
          continue
        }
        if (at <= window.from.getTime() || at > window.to.getTime()) continue
      }

      const qty = exec.quantity ?? 0
      if (qty === 0) continue
      const signed = leg.buy ? qty : -qty
      symbols.set(leg.symbol, (symbols.get(leg.symbol) ?? 0) + signed)
    }
  }

  for (const [symbol, qty] of symbols) if (qty === 0) symbols.delete(symbol)

  return { orderId, symbols, refusals }
}

export interface SummedEffects {
  symbols: SymbolQty
  refusals: string[]
  /** Order ids that contributed a non-empty effect — the interval's activity. */
  contributingOrderIds: string[]
}

/**
 * Total signed position change across a set of orders.
 *
 * Pass `window` to bound the interval by EXECUTION time. Never bound it by
 * `enteredTime` — that is PLACEMENT time, and a GTC entered months ago can
 * fill today. Conflating them is the 180-day GTC trap in a different costume,
 * and it fails silently in both directions.
 */
export function sumEffects(
  orders: readonly SchwabOrderDetail[],
  window?: ExecutionWindow,
): SummedEffects {
  let symbols: SymbolQty = new Map<string, number>()
  const refusals: string[] = []
  const contributingOrderIds: string[] = []

  for (const order of orders) {
    const effect = orderEffect(order, window)
    refusals.push(...effect.refusals)
    if (effect.symbols.size > 0) {
      symbols = addQty(symbols, effect.symbols)
      contributingOrderIds.push(effect.orderId)
    }
  }

  return { symbols, refusals, contributingOrderIds }
}

/**
 * Latest execution timestamp on an order, or null if nothing executed.
 * Exported so the ingestion layer can bound an interval by FILL time rather
 * than by `enteredTime` (see sumEffects above).
 */
export function lastExecutionTime(order: SchwabOrderDetail): string | null {
  let latest: string | null = null
  for (const activity of order.orderActivityCollection ?? []) {
    for (const exec of activity.executionLegs ?? []) {
      if (exec.time && (latest === null || exec.time > latest)) latest = exec.time
    }
  }
  return latest
}
