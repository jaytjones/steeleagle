// ============================================================
// SteelEagle — v2.0 Order Ticket Builder (pure — no I/O)
//
// Builds the canonical Schwab POST /orders payload for a 4-leg iron
// condor placed as a single NET_CREDIT limit order.
//
// The payload shape is pinned to a REAL order recorded by Schwab on
// July 12, 2026: an unfillable SPY condor was placed in thinkorswim and
// read back via GET /accounts/{hash}/orders (scripts/dump-working-orders.ts).
// Do NOT restructure this payload from memory or third-party docs — if the
// shape ever needs to change, re-derive it the same way. (Field-name-
// mismatch lesson; spec §4.)
//
// Canonical values confirmed from the live readback:
//   orderStrategyType:        "SINGLE"
//   complexOrderStrategyType: "IRON_CONDOR"
//   orderType:                "NET_CREDIT"  (+ top-level `price`)
//   duration/session:         "DAY" / "NORMAL"
//   legs: { instruction, quantity, instrument: { assetType, symbol } }
//   leg order: short call, long call, short put, long put (as TOS emitted)
//
// Read-only echo fields (orderId, status, enteredTime, cusip, legId,
// positionEffect, …) are deliberately absent — they are never POSTed.
//
// Schwab performs NO server-side review: a valid payload submits and can
// execute immediately. This module + its golden-fixture tests are the
// primary safety layer (spec §5 Layer 1).
// ============================================================

import type { CondorSetup } from '@/types'

/**
 * Structural input for the builder — CondorSetup satisfies this, and the
 * server action reconstructs it from zod-validated primitives (never from
 * a client-supplied ticket object).
 */
export interface CondorOrderInput {
  symbol: string
  expiration: string // YYYY-MM-DD
  longPut: { strike: number }
  shortPut: { strike: number }
  shortCall: { strike: number }
  longCall: { strike: number }
  /** Per-share mid credit; used only when opts.price is not supplied. */
  totalCredit?: number
}

// Compile-time proof that CondorSetup remains a valid input.
const _condorSetupIsAssignable = (s: CondorSetup): CondorOrderInput => s
void _condorSetupIsAssignable

// --------------------------------------------------------
// Payload types (exactly what gets POSTed — nothing more)
// --------------------------------------------------------
export type OrderInstruction = 'BUY_TO_OPEN' | 'SELL_TO_OPEN'

export interface CondorOrderLeg {
  instruction: OrderInstruction
  quantity: number
  instrument: {
    assetType: 'OPTION'
    symbol: string // 21-char OCC symbol
  }
}

export interface CondorOrderTicket {
  orderStrategyType: 'SINGLE'
  complexOrderStrategyType: 'IRON_CONDOR'
  orderType: 'NET_CREDIT'
  /**
   * Net credit as a pre-formatted string. Schwab treats price as a string
   * under the hood with truncation quirks (< $1 → 4 dp, ≥ $1 → 2 dp);
   * formatting it ourselves avoids surprise rounding on the credit.
   */
  price: string
  duration: 'DAY'
  session: 'NORMAL'
  quantity: number
  orderLegCollection: [CondorOrderLeg, CondorOrderLeg, CondorOrderLeg, CondorOrderLeg]
}

// --------------------------------------------------------
// OCC symbol construction — exact inverse of parseOccSymbol
// (lib/strategy/reconstruct-positions.ts). Format:
//   root (padded to 6 with spaces) + YYMMDD + C|P + strike*1000 (8 digits)
// e.g. buildOccSymbol('SPY','2026-08-21','CALL',850) → "SPY   260821C00850000"
// --------------------------------------------------------
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function buildOccSymbol(
  underlying: string,
  expiration: string, // YYYY-MM-DD (the format condor-builder / chains emit)
  putCall: 'PUT' | 'CALL',
  strike: number,
): string {
  const root = underlying.trim().toUpperCase()
  if (!root || root.length > 6) {
    throw new Error(`buildOccSymbol: invalid underlying "${underlying}"`)
  }
  if (!ISO_DATE.test(expiration)) {
    throw new Error(`buildOccSymbol: expiration must be YYYY-MM-DD, got "${expiration}"`)
  }
  if (!(strike > 0)) {
    throw new Error(`buildOccSymbol: strike must be positive, got ${strike}`)
  }
  // Strike is encoded as strike × 1000 in 8 digits; that supports at most
  // 3 decimal places. Reject anything finer rather than silently rounding.
  const milli = strike * 1000
  const milliRounded = Math.round(milli)
  if (Math.abs(milli - milliRounded) > 1e-6) {
    throw new Error(`buildOccSymbol: strike ${strike} has sub-$0.001 precision`)
  }
  const strikeField = String(milliRounded).padStart(8, '0')
  if (strikeField.length > 8) {
    throw new Error(`buildOccSymbol: strike ${strike} exceeds OCC 8-digit field`)
  }
  const date = expiration.slice(2, 4) + expiration.slice(5, 7) + expiration.slice(8, 10)
  return `${root.padEnd(6, ' ')}${date}${putCall === 'PUT' ? 'P' : 'C'}${strikeField}`
}

// --------------------------------------------------------
// Price formatting — mirror Schwab's truncation rules so what we send is
// exactly what Schwab would store: truncate (not round) to 4 dp below $1,
// 2 dp at or above $1.
// --------------------------------------------------------
export function formatOrderPrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`formatOrderPrice: price must be a positive number, got ${price}`)
  }
  const dp = price < 1 ? 4 : 2
  const factor = 10 ** dp
  // Truncate with a tiny epsilon so float artifacts (1.7999999…) don't
  // knock a clean 1.80 down to 1.79.
  const truncated = Math.floor(price * factor + 1e-9) / factor
  return truncated.toFixed(dp)
}

// --------------------------------------------------------
// The builder
// --------------------------------------------------------
export interface BuildCondorOrderOptions {
  /** Contracts (order-level and per-leg). Integer ≥ 1. */
  quantity: number
  /**
   * Net credit to ask, per share (e.g. 1.80). Defaults to the setup's
   * totalCredit (the mid-price credit the scanner computed) — but the
   * confirmation UI should always surface and allow editing this before
   * submission, since mid rarely fills as-is.
   */
  price?: number
}

/**
 * CondorSetup → the exact Schwab order JSON to POST.
 *
 * Throws (never returns a malformed ticket) on any structural violation:
 * strike ordering, wing asymmetry vs. the setup, credit ≥ wing width,
 * bad quantity, unparseable expiration. A thrown error here is the
 * guardrail working — Schwab will NOT catch these for us.
 */
export function buildCondorOrder(
  setup: CondorOrderInput,
  opts: BuildCondorOrderOptions,
): CondorOrderTicket {
  const { symbol, expiration, longPut, shortPut, shortCall, longCall } = setup
  const quantity = opts.quantity
  const price = opts.price ?? setup.totalCredit

  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(`buildCondorOrder: quantity must be a positive integer, got ${quantity}`)
  }

  // Structural sanity: LP < SP < SC < LC, all distinct.
  const strikes = [longPut.strike, shortPut.strike, shortCall.strike, longCall.strike]
  if (!strikes.every((s) => Number.isFinite(s) && s > 0)) {
    throw new Error('buildCondorOrder: all four strikes must be positive numbers')
  }
  if (!(longPut.strike < shortPut.strike && shortPut.strike < shortCall.strike && shortCall.strike < longCall.strike)) {
    throw new Error(
      `buildCondorOrder: strikes must satisfy LP < SP < SC < LC, got ` +
        `${longPut.strike} / ${shortPut.strike} / ${shortCall.strike} / ${longCall.strike}`,
    )
  }

  // Credit must be positive and strictly less than the narrower wing —
  // a credit ≥ wing width is impossible on a condor and means bad input.
  const putWing = shortPut.strike - longPut.strike
  const callWing = longCall.strike - shortCall.strike
  const narrowerWing = Math.min(putWing, callWing)
  if (price === undefined || !(price > 0)) {
    throw new Error(`buildCondorOrder: net credit must be positive, got ${price}`)
  }
  if (price >= narrowerWing) {
    throw new Error(
      `buildCondorOrder: net credit ${price} ≥ narrower wing width ${narrowerWing} — impossible fill, refusing to build`,
    )
  }

  // Leg order mirrors the canonical TOS-recorded order: SC, LC, SP, LP.
  const legs: [CondorOrderLeg, CondorOrderLeg, CondorOrderLeg, CondorOrderLeg] = [
    leg('SELL_TO_OPEN', quantity, buildOccSymbol(symbol, expiration, 'CALL', shortCall.strike)),
    leg('BUY_TO_OPEN', quantity, buildOccSymbol(symbol, expiration, 'CALL', longCall.strike)),
    leg('SELL_TO_OPEN', quantity, buildOccSymbol(symbol, expiration, 'PUT', shortPut.strike)),
    leg('BUY_TO_OPEN', quantity, buildOccSymbol(symbol, expiration, 'PUT', longPut.strike)),
  ]

  return {
    orderStrategyType: 'SINGLE',
    complexOrderStrategyType: 'IRON_CONDOR',
    orderType: 'NET_CREDIT',
    price: formatOrderPrice(price),
    duration: 'DAY',
    session: 'NORMAL',
    quantity,
    orderLegCollection: legs,
  }
}

function leg(instruction: OrderInstruction, quantity: number, symbol: string): CondorOrderLeg {
  return { instruction, quantity, instrument: { assetType: 'OPTION', symbol } }
}
