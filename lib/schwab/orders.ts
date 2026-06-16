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
