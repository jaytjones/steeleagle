// ============================================================
// SteelEagle — Schwab Orders Service (Session 10 — v1.5.1)
//
// Fetches filled orders so the position importer can recover the actual
// per-leg fill prices and the original open date for each open condor.
// Same getAccessToken() + traderGet() pattern as accounts.ts.
//
// The /orders endpoint is throttled at 10 req/min/account; the importer
// makes exactly one call per import session, so no rate-limit concern.
// ============================================================

import { traderGet } from './client'

// --------------------------------------------------------
// Schwab order JSON shape — only the fields the importer reads are typed.
// --------------------------------------------------------
export interface SchwabExecutionLeg {
  legId: number
  price: number // actual fill price per share for this leg
  quantity?: number // contracts in this execution (v2.0 fill mapping)
  time?: string
}

export interface SchwabOrderActivity {
  executionLegs?: SchwabExecutionLeg[]
}

export interface SchwabOrderLeg {
  legId?: number
  instrument: {
    assetType?: string
    symbol: string // OCC symbol — the matching key against position legs
    putCall?: 'PUT' | 'CALL'
    underlyingSymbol?: string
    strikePrice?: number
    expirationDate?: string
  }
  instruction: string // BUY_TO_OPEN / SELL_TO_OPEN / BUY_TO_CLOSE / SELL_TO_CLOSE
  quantity: number
}

export interface SchwabOrder {
  orderId: number
  enteredTime: string // ISO datetime
  status?: string
  orderLegCollection?: SchwabOrderLeg[]
  orderActivityCollection?: SchwabOrderActivity[]
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Fetch filled orders from Schwab for the past `lookbackDays` calendar days.
 * Returns the raw Schwab order array — parsing is done in the importer.
 *
 * Degrades gracefully: any non-200 / network / shape failure is logged and
 * surfaced as an empty array so the importer falls back to marks-only mode
 * rather than failing the whole import (spec §5.1).
 */
export async function getFilledOrders(
  accountHash: string,
  lookbackDays: number = 90,
): Promise<SchwabOrder[]> {
  const to = new Date()
  const from = new Date(to.getTime() - lookbackDays * MS_PER_DAY)

  try {
    const orders = await traderGet<SchwabOrder[]>(`/accounts/${accountHash}/orders`, {
      fromEnteredTime: from.toISOString(),
      toEnteredTime: to.toISOString(),
      status: 'FILLED',
    })
    return Array.isArray(orders) ? orders : []
  } catch (err) {
    console.error(
      'getFilledOrders — order history unavailable, degrading to marks-only:',
      err instanceof Error ? err.message : String(err),
    )
    return []
  }
}

// ============================================================
// v2.0 — Order placement / status / cancel (first Schwab WRITE path)
//
// Unlike getFilledOrders above, these do NOT degrade gracefully — a
// failed write must surface loudly, never be swallowed into a default.
// Schwab performs no server-side review: a valid POST submits and can
// execute immediately. Every caller is behind the operator-confirmed
// gate in the UI (spec §3.3).
// ============================================================

import { traderWrite } from './client'
import type { CondorOrderTicket } from './order-ticket'

/** Extended order fields the v2.0 flow reads back (superset of the importer's needs). */
export interface SchwabOrderDetail extends SchwabOrder {
  price?: number
  quantity?: number
  filledQuantity?: number
  remainingQuantity?: number
  orderType?: string
  complexOrderStrategyType?: string
  cancelable?: boolean
  closeTime?: string
}

/**
 * Place an order. Returns the Schwab order id, extracted from the
 * Location header of the 201 response (…/orders/{orderId}).
 */
export async function placeOrder(
  accountHash: string,
  ticket: CondorOrderTicket,
): Promise<{ orderId: string }> {
  const result = await traderWrite('POST', `/accounts/${accountHash}/orders`, ticket)

  const orderId = result.location?.split('/').filter(Boolean).pop() ?? null
  if (!orderId || !/^\d+$/.test(orderId)) {
    // The POST returned 2xx — the order may be LIVE at Schwab even though we
    // couldn't parse its id. Be explicit so the operator checks TOS.
    throw new Error(
      `placeOrder: Schwab accepted the order (HTTP ${result.status}) but no order id ` +
        `could be read from the Location header ("${result.location ?? 'missing'}"). ` +
        `CHECK THINKORSWIM — the order may be working.`,
    )
  }
  return { orderId }
}

/** Read back a single order's status/detail. */
export function getOrder(accountHash: string, orderId: string): Promise<SchwabOrderDetail> {
  return traderGet<SchwabOrderDetail>(`/accounts/${accountHash}/orders/${orderId}`)
}

/** Cancel a working order. Throws on failure (non-2xx). */
export async function cancelOrder(accountHash: string, orderId: string): Promise<void> {
  await traderWrite('DELETE', `/accounts/${accountHash}/orders/${orderId}`)
}

// ============================================================
// v2.2 — wholesale order fetch for the exit sweep (spec §4.3 step 0)
// ============================================================

/**
 * Fetch ALL orders (no status filter) from the past `lookbackDays`.
 * One call per sweep: the planner matches standing exits by id and runs
 * the pre-place guard against working closes from this single set.
 *
 * The 180-day default exists because GTC orders can stand for months —
 * `fromEnteredTime` filters on PLACEMENT time, so a short window would
 * silently drop a long-standing GTC and make it look canceled/absent.
 *
 * CRITICAL — failure semantics are the OPPOSITE of getFilledOrders:
 * this THROWS on any fetch/shape failure and must never degrade to [].
 * An empty array here means "no working orders exist", which would let
 * the sweep place duplicate GTC exits alongside live ones. The cron
 * catches the throw and degrades the ENTIRE exitSweep to an errors[]
 * entry instead (spec §4.3 / §5.6) — no reconcile, no placement, no
 * guessing.
 */
export async function getWorkingAndRecentOrders(
  accountHash: string,
  lookbackDays: number = 180,
): Promise<SchwabOrderDetail[]> {
  const to = new Date()
  const from = new Date(to.getTime() - lookbackDays * MS_PER_DAY)

  const orders = await traderGet<SchwabOrderDetail[]>(`/accounts/${accountHash}/orders`, {
    fromEnteredTime: from.toISOString(),
    toEnteredTime: to.toISOString(),
    // no `status` param — the sweep needs WORKING and terminal states alike
  })
  if (!Array.isArray(orders)) {
    throw new Error(
      'getWorkingAndRecentOrders: /orders returned a non-array body — refusing to sweep on unverifiable order state',
    )
  }
  return orders
}
