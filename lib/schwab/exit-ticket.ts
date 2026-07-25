// ============================================================
// SteelEagle — v2.2 Exit Ticket Builder (pure — no I/O)
//
// Builds the canonical Schwab POST /orders payload for closing a 4-leg
// iron condor as a single GTC NET_DEBIT limit order (the 50%-profit
// standing exit, spec §4.1/§4.2).
//
// The payload shape is pinned to REAL orders recorded by Schwab and
// dumped July 24, 2026 (scripts/dump-working-orders.ts): manually
// placed GTC condor closes on AAPL (orderId 1006748128062 et al.) and
// SPY (1006723418260). Do NOT restructure from memory or docs — the
// draft spec guessed `duration: "GTC"`; Schwab actually records
// "GOOD_TILL_CANCEL". This is why fixtures exist.
//
// Canonical values confirmed from the live records:
//   orderStrategyType:        "SINGLE"
//   complexOrderStrategyType: "IRON_CONDOR"
//   orderType:                "NET_DEBIT"  (+ top-level `price`)
//   duration/session:         "GOOD_TILL_CANCEL" / "NORMAL"
//   legs: { instruction, quantity, instrument: { assetType, symbol } }
//   leg order: short call, long call, short put, long put
//              (BUY_TO_CLOSE / SELL_TO_CLOSE / BUY_TO_CLOSE / SELL_TO_CLOSE)
//   — identical leg ordering to the entry ticket's TOS-recorded order.
//
// Read-only echo fields (orderId, status, positionEffect, cusip, legId,
// closeTime, accountNumber, …) are deliberately absent — never POSTed.
//
// Schwab performs NO server-side review. This module + its golden tests
// are the primary safety layer for the exit path, exactly as
// order-ticket.ts (untouched) is for the entry path.
// ============================================================

import type { TradeEvent } from '../journal/types'
import { buildOccSymbol, formatOrderPrice } from './order-ticket'

// --------------------------------------------------------
// Payload types (exactly what gets POSTed — nothing more)
// --------------------------------------------------------
export type ExitOrderInstruction = 'BUY_TO_CLOSE' | 'SELL_TO_CLOSE'

export interface CondorExitLeg {
  instruction: ExitOrderInstruction
  quantity: number
  instrument: {
    assetType: 'OPTION'
    symbol: string // 21-char OCC symbol
  }
}

export interface CondorExitTicket {
  orderStrategyType: 'SINGLE'
  complexOrderStrategyType: 'IRON_CONDOR'
  orderType: 'NET_DEBIT'
  /** Pre-formatted price string — same truncation semantics as entry. */
  price: string
  duration: 'GOOD_TILL_CANCEL' // NOT "GTC" — pinned from the live record
  session: 'NORMAL'
  quantity: number
  orderLegCollection: [CondorExitLeg, CondorExitLeg, CondorExitLeg, CondorExitLeg]
}

// --------------------------------------------------------
// Structural input — derived from journal entry events (§4.1a), never
// from a client-supplied object.
// --------------------------------------------------------
export interface CondorExitInput {
  symbol: string
  expiration: string // YYYY-MM-DD
  longPut: { strike: number }
  shortPut: { strike: number }
  shortCall: { strike: number }
  longCall: { strike: number }
}

/**
 * Journal `open` events → exit-ticket input (spec §4.1a leg derivation).
 *
 * Source of truth for the legs is the trade's entry `open` events — exact
 * for unrolled trades, which are the only trades the v2.2 sweep places on
 * (rolled trades are excluded upstream by the planner). Refusal posture
 * identical to recordFillAction: any ambiguity throws; nothing is guessed.
 */
export function exitInputFromOpenEvents(
  symbol: string,
  events: Array<Pick<TradeEvent, 'eventType' | 'leg' | 'strike' | 'expiration'>>,
): CondorExitInput {
  const opens = events.filter((e) => e.eventType === 'open')
  if (opens.length !== 4) {
    throw new Error(
      `exitInputFromOpenEvents: expected exactly 4 open events, got ${opens.length} — refusing to build`,
    )
  }

  const byLeg = new Map(opens.map((e) => [e.leg, e]))
  if (byLeg.size !== 4) {
    const seen = opens.map((e) => e.leg).join(', ')
    throw new Error(
      `exitInputFromOpenEvents: open events must cover each leg exactly once, got [${seen}]`,
    )
  }

  const expirations = new Set(opens.map((e) => e.expiration))
  if (expirations.size !== 1) {
    throw new Error(
      `exitInputFromOpenEvents: open events span multiple expirations [${[...expirations].join(', ')}] — refusing to build`,
    )
  }

  return {
    symbol,
    expiration: opens[0].expiration,
    longPut: { strike: byLeg.get('long_put')!.strike },
    shortPut: { strike: byLeg.get('short_put')!.strike },
    shortCall: { strike: byLeg.get('short_call')!.strike },
    longCall: { strike: byLeg.get('long_call')!.strike },
  }
}

// --------------------------------------------------------
// Exit price (spec §4.2 / finding 4)
// --------------------------------------------------------

/**
 * The 50%-profit target debit, per share, pre-formatted.
 *
 * `netCredit/share ÷ 2`, then formatOrderPrice — which TRUNCATES (floors),
 * the deliberate, profit-favorable direction pinned by finding 4:
 * $2.23/share credit → $1.115 → "1.11".
 *
 * Sub-$1 targets format at 4 dp per the shipped convention (e.g. $0.75 →
 * "0.7500"); whether Schwab accepts 4 dp NET_DEBIT prices on
 * penny-increment options is an open item verified at the first real
 * sub-$1 placement (spec §6b).
 */
export function computeExitDebit(
  totalCreditCollected: number,
  totalDebitPaid: number,
  contracts: number,
): string {
  if (!Number.isInteger(contracts) || contracts < 1) {
    throw new Error(`computeExitDebit: contracts must be a positive integer, got ${contracts}`)
  }
  const netCredit = totalCreditCollected - totalDebitPaid
  if (!(netCredit > 0)) {
    throw new Error(
      `computeExitDebit: net credit must be positive, got ${netCredit} ` +
        `(collected ${totalCreditCollected} − paid ${totalDebitPaid}) — refusing to price an exit`,
    )
  }
  const perShare = netCredit / (contracts * 100)
  return formatOrderPrice(perShare / 2)
}

// --------------------------------------------------------
// The builder
// --------------------------------------------------------
export interface BuildCondorExitOptions {
  /** Contracts (order-level and per-leg). Integer ≥ 1. */
  quantity: number
  /** Target debit, per share (e.g. 1.11). Positive; < narrower wing. */
  debit: number
}

/**
 * CondorExitInput → the exact Schwab GTC close JSON to POST.
 *
 * Throws (never returns a malformed ticket) on any structural violation:
 * strike ordering, non-positive or impossible debit, bad quantity. A
 * thrown error here is the guardrail working — Schwab will NOT catch
 * these for us.
 */
export function buildCondorExitTicket(
  input: CondorExitInput,
  opts: BuildCondorExitOptions,
): CondorExitTicket {
  const { symbol, expiration, longPut, shortPut, shortCall, longCall } = input
  const { quantity, debit } = opts

  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(`buildCondorExitTicket: quantity must be a positive integer, got ${quantity}`)
  }

  const strikes = [longPut.strike, shortPut.strike, shortCall.strike, longCall.strike]
  if (!strikes.every((s) => Number.isFinite(s) && s > 0)) {
    throw new Error('buildCondorExitTicket: all four strikes must be positive numbers')
  }
  if (
    !(
      longPut.strike < shortPut.strike &&
      shortPut.strike < shortCall.strike &&
      shortCall.strike < longCall.strike
    )
  ) {
    throw new Error(
      `buildCondorExitTicket: strikes must satisfy LP < SP < SC < LC, got ` +
        `${longPut.strike} / ${shortPut.strike} / ${shortCall.strike} / ${longCall.strike}`,
    )
  }

  // A close debit ≥ the narrower wing exceeds the structure's maximum
  // possible value — impossible fill, means bad input upstream.
  const narrowerWing = Math.min(shortPut.strike - longPut.strike, longCall.strike - shortCall.strike)
  if (!(debit > 0)) {
    throw new Error(`buildCondorExitTicket: debit must be positive, got ${debit}`)
  }
  if (debit >= narrowerWing) {
    throw new Error(
      `buildCondorExitTicket: debit ${debit} ≥ narrower wing width ${narrowerWing} — impossible fill, refusing to build`,
    )
  }

  // Leg order mirrors the live-recorded GTC closes: SC, LC, SP, LP.
  const legs: [CondorExitLeg, CondorExitLeg, CondorExitLeg, CondorExitLeg] = [
    leg('BUY_TO_CLOSE', quantity, buildOccSymbol(symbol, expiration, 'CALL', shortCall.strike)),
    leg('SELL_TO_CLOSE', quantity, buildOccSymbol(symbol, expiration, 'CALL', longCall.strike)),
    leg('BUY_TO_CLOSE', quantity, buildOccSymbol(symbol, expiration, 'PUT', shortPut.strike)),
    leg('SELL_TO_CLOSE', quantity, buildOccSymbol(symbol, expiration, 'PUT', longPut.strike)),
  ]

  return {
    orderStrategyType: 'SINGLE',
    complexOrderStrategyType: 'IRON_CONDOR',
    orderType: 'NET_DEBIT',
    price: formatOrderPrice(debit),
    duration: 'GOOD_TILL_CANCEL',
    session: 'NORMAL',
    quantity,
    orderLegCollection: legs,
  }
}

function leg(instruction: ExitOrderInstruction, quantity: number, symbol: string): CondorExitLeg {
  return { instruction, quantity, instrument: { assetType: 'OPTION', symbol } }
}
