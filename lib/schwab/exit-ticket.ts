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

import {
  isOrderFixturePinned,
  preferredRootFor,
  unpinnedFixtureMessage,
} from '@/lib/strategy/instruments'
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
  /**
   * v2.4 — OCC root for the close legs. Optional: omitted falls back to the
   * instrument's `preferredRoot`, which equals `symbol` for every ETF and for
   * XSP. `CondorStructure` (lib/journal/current-structure.ts) supplies it, and
   * that function refuses multi-root indices outright — so a root reaching this
   * builder is always the instrument's one unambiguous root, never a guess.
   */
  root?: string
  expiration: string // YYYY-MM-DD
  longPut: { strike: number }
  shortPut: { strike: number }
  shortCall: { strike: number }
  longCall: { strike: number }
}

// v2.3: leg derivation moved OUT of this module to
// `lib/journal/current-structure.ts`. `exitInputFromOpenEvents` derived legs
// from entry `open` events only — correct just for unrolled trades, which is
// why v2.2 excluded rolled trades from placement. `currentStructure(events)`
// folds the whole log (rolls included) and returns this same shape, so there
// is ONE leg-derivation path. The old function was deleted rather than
// deprecated: two paths is how a rolled trade gets priced at pre-roll strikes.

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

  // v2.4 — same doctrine gate as the entry builder. The sweep's placement
  // predicate already refuses unpinned instruments upstream; this is the
  // defence-in-depth copy, so no future caller can reach Schwab around it.
  if (!isOrderFixturePinned(symbol)) {
    throw new Error(`buildCondorExitTicket: ${unpinnedFixtureMessage(symbol)}`)
  }
  const root = input.root ?? preferredRootFor(symbol)

  const strikes = [longPut.strike, shortPut.strike, shortCall.strike, longCall.strike]
  if (!strikes.every((s) => Number.isFinite(s) && s > 0)) {
    throw new Error('buildCondorExitTicket: all four strikes must be positive numbers')
  }
  // Session 20 — the butterfly (SP == SC) is separated out from the generic
  // ordering failure because the two are different kinds of problem and the
  // operator reads these strings. A generic "must satisfy LP < SP < SC < LC" on
  // a deliberately-opened butterfly reads as a bug in the app; this says what is
  // actually missing. `currentStructure` refuses both upstream, so the sweep
  // never reaches here — this is the defence-in-depth copy, same as the fixture
  // gate above, so no future caller can build a butterfly payload around it.
  if (shortPut.strike === shortCall.strike) {
    throw new Error(
      `buildCondorExitTicket: both shorts at ${shortPut.strike} — an iron BUTTERFLY. ` +
        `complexOrderStrategyType "IRON_CONDOR" is pinned from real condor closes and has ` +
        `never been verified for a butterfly. Place-and-cancel one first (Schwab does no ` +
        `server-side review), then pin it. Refusing to build.`,
    )
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
    leg('BUY_TO_CLOSE', quantity, buildOccSymbol(root, expiration, 'CALL', shortCall.strike)),
    leg('SELL_TO_CLOSE', quantity, buildOccSymbol(root, expiration, 'CALL', longCall.strike)),
    leg('BUY_TO_CLOSE', quantity, buildOccSymbol(root, expiration, 'PUT', shortPut.strike)),
    leg('SELL_TO_CLOSE', quantity, buildOccSymbol(root, expiration, 'PUT', longPut.strike)),
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
