// ============================================================
// SteelEagle — v2.11 fill → journal form pre-fill (pure — no I/O)
//
// Turns a classified fill into the rows the Roll and Close forms already
// render, so the operator confirms numbers instead of transcribing them.
//
// ── The hardening this must NOT undo ──
//
// v2.2.1, v2.3.1 and v2.3.2 each hardened one journal write path against
// `Number('') === 0`, after three blank price fields reached the DB as three
// real $0.00 close events (Session 15). The forms carry `strike`/`price` as
// STRINGS and convert with `numOrNull`, so "" stays absent rather than becoming
// zero.
//
// This module therefore emits STRINGS too, and — critically — emits the EMPTY
// STRING for anything it does not actually know. A fill with no execution price
// (a rejected or working order) pre-fills a blank price field, never "0.00".
// $0.00 is a legitimate fill price for a worthless long, so a fabricated zero
// here would be indistinguishable from a real one and would mis-price the
// standing GTC the sweep builds from it.
//
// `delta` is always blank: Schwab's order payload carries no greeks, and the
// journal's delta column is optional metadata.
//
// ── The instruction table (the F3 inverse) ──
//
// classify-fill maps an instruction to a leg ROLE. This maps a role and an
// action back to the instruction — which is what both the credit/debit
// direction and the operator-facing label need:
//
//   close + short  →  BUY_TO_CLOSE   pay to buy it back      → debit
//   close + long   →  SELL_TO_CLOSE  collect on the way out   → credit
//   open  + short  →  SELL_TO_OPEN   collect premium          → credit
//   open  + long   →  BUY_TO_OPEN    pay for the wing         → debit
//
// Which collapses to: BUY is a debit, SELL is a credit. The same table drives
// the inbox's leg label, so the two can never disagree about what a leg was.
// ============================================================

import type { FillClassification } from './classify-fill'
import type { CreditDebit, Leg } from './types'

export type FillInstruction = 'BUY_TO_OPEN' | 'BUY_TO_CLOSE' | 'SELL_TO_OPEN' | 'SELL_TO_CLOSE'

const isShortRole = (role: Leg) => role === 'short_put' || role === 'short_call'

/** The F3 inverse: what Schwab instruction produced this (action, role) pair. */
export function instructionFor(action: 'open' | 'close', role: Leg): FillInstruction {
  if (action === 'close') return isShortRole(role) ? 'BUY_TO_CLOSE' : 'SELL_TO_CLOSE'
  return isShortRole(role) ? 'SELL_TO_OPEN' : 'BUY_TO_OPEN'
}

/** Buying pays, selling collects. Derived from the instruction, never restated. */
export function creditDebitFor(action: 'open' | 'close', role: Leg): CreditDebit {
  return instructionFor(action, role).startsWith('BUY') ? 'debit' : 'credit'
}

/**
 * One pre-filled leg row. Field-for-field compatible with the forms'
 * `EditableLeg`, deliberately: this module owns the DECISION about what each
 * field should contain, and the component owns the rendering.
 */
export interface PrefillLegRow {
  eventType?: 'roll_close' | 'roll_open'
  leg: Leg
  strike: string
  expiration: string
  delta: string
  price: string
  creditDebit: CreditDebit
}

export interface FillPrefill {
  /** 'roll' or 'close' — which form to open. */
  mode: 'roll' | 'close'
  /** ISO instant of the fill; the form converts to its datetime-local input. */
  occurredAt: string
  rows: PrefillLegRow[]
  /** Provenance, written into the notes field so the journal records its source. */
  notes: string
  /** True when at least one row has no price — the operator must supply it. */
  hasMissingPrices: boolean
}

/** Money as the form wants it: a plain 2dp string, or "" when genuinely absent. */
function priceString(price: number | null): string {
  return price === null ? '' : price.toFixed(2)
}

/** Strikes are whole or half dollars; render without trailing noise. */
function strikeString(strike: number): string {
  return String(strike)
}

/**
 * Build the pre-fill for a fill, or null when the shape has no form to open.
 *
 * CONDOR_OPEN deliberately returns null: an entry needs `initialBpr`, which is
 * nowhere in the order payload, and `enteredBpr` refuses 0 by design. Import
 * from Schwab is the path for those, and it already asks for BPR on the review
 * card. Pre-filling a form that cannot be submitted would be worse than not
 * offering one.
 */
export function fillToPrefill(fill: FillClassification): FillPrefill | null {
  // NOTHING EXECUTED ⇒ NOTHING TO JOURNAL. A REJECTED or WORKING order has a
  // shape and legs, so it classifies fine and belongs in the ledger — but it
  // moved no contracts, and offering a pre-filled close form for it (with every
  // price blank, because there were no executions) invites journaling an event
  // that never happened. The action for a rejection is to investigate drift,
  // which is what its verdict already says.
  //
  // Caught by the live check 2026-08-14: the five GLD rejections were each
  // offering "Journal this close" with four blank prices.
  if (!fill.filled) return null

  if (fill.shape === 'CONDOR_CLOSE') {
    return {
      mode: 'close',
      occurredAt: fill.occurredAt,
      notes: `Journaled from Schwab order ${fill.orderId}.`,
      rows: fill.legs.map((l) => ({
        leg: l.role,
        strike: strikeString(l.strike),
        expiration: l.expiration,
        delta: '',
        price: priceString(l.price),
        creditDebit: creditDebitFor(l.action, l.role),
      })),
      hasMissingPrices: fill.legs.some((l) => l.price === null),
    }
  }

  if (fill.shape === 'ROLL' || fill.shape === 'PARTIAL_CLOSE' || fill.shape === 'PARTIAL_OPEN') {
    return {
      mode: 'roll',
      occurredAt: fill.occurredAt,
      notes:
        fill.shape === 'ROLL'
          ? `Journaled from Schwab order ${fill.orderId}.`
          : // A split roll is TWO orders. Say so in the note the journal keeps,
            // because the other half's legs must be added by hand before this
            // submits — RollTradeSchema refuses a roll_open with no matching
            // roll_close on the same role.
            `Journaled from Schwab order ${fill.orderId} — one half of a SPLIT roll. ` +
            `Add the partner ticket's legs before saving.`,
      // Closes before opens, matching how currentStructure folds a roll batch
      // and how the operator reads it: what left, then what replaced it.
      rows: [...fill.legs]
        .sort((a, b) => (a.action === b.action ? 0 : a.action === 'close' ? -1 : 1))
        .map((l) => ({
          eventType: l.action === 'close' ? ('roll_close' as const) : ('roll_open' as const),
          leg: l.role,
          strike: strikeString(l.strike),
          expiration: l.expiration,
          delta: '',
          price: priceString(l.price),
          creditDebit: creditDebitFor(l.action, l.role),
        })),
      hasMissingPrices: fill.legs.some((l) => l.price === null),
    }
  }

  // CONDOR_OPEN (needs BPR — use Import), NOT_OPTION, AMBIGUOUS.
  return null
}
