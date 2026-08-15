// ============================================================
// SteelEagle — v2.2.1 closed-trade edit planner (pure — no I/O)
//
// Decides what an edit is allowed to touch and what each touched row
// becomes. The DB layer only executes the plan; every refusal lives here.
//
// Editable = ANY `close` event, and only its price / direction / timestamp.
// Everything else is refused, loudly:
//   - `open` / `roll_open` / `roll_close` events — entry and roll legs carry
//     live-data provenance (April's explicit rule). Editing a roll_close on
//     an open trade would also desync the standing GTC's 50% target.
//   - structure (leg / strike / expiration / contracts) — an edit repairs a
//     mis-keyed fill, it never restates the position.
//
// ── v2.12: `schwab_fill` closes became editable (April, 2026-08-15) ──
//
// The original rule refused them: "that is Schwab's record of a real execution,
// not a typed number." The reasoning was sound and the conclusion was too
// strong. Two things changed it:
//
//  1. It was never hypothetical. The v2.2 sweep reconcile has always written
//     closes with source 'schwab_fill', so a sweep-journaled close has always
//     been unrepairable except by hand-written SQL — which is precisely what
//     this module exists to avoid.
//  2. Schwab's execution data is not self-evidently right. v2.11 found orders
//     carrying zero-value execution legs on REPLACED/CANCELED tickets, and a
//     fractional dollar quantity on an equity order. `closeInputFromFilledExit`
//     derives a quantity-weighted average from that data; a derived number can
//     be wrong in ways the raw record is not.
//
// This is a PRECONDITION for v2.11's gated auto-write (spec §8.1): the cron
// must not be able to write a close the operator cannot then correct.
//
// PROVENANCE IS PRESERVED, NOT ERASED. Editing a `schwab_fill` close flips its
// `source` to 'manual' while KEEPING `schwab_order_id`. The two columns answer
// different questions — `schwab_order_id` says which order this leg came from,
// `source` says where the NUMBER came from — and after a hand edit the honest
// answers are "order X" and "typed". Leaving source as 'schwab_fill' would make
// the journal claim Schwab's record for a number the operator overrode.
//
// Refusal posture matches every other write path: an unknown or ineligible
// id refuses the WHOLE edit rather than silently applying the rest.
// ============================================================

import { deriveTotals, legAmount } from './trade-math'
import type { CreditDebit, TradeEvent } from './types'

/** One operator-supplied repair, already zod-validated for shape. */
export interface CloseEventPatch {
  id: string
  price: number
  creditDebit: CreditDebit
  occurredAt: string
}

/** One row the DB layer will UPDATE. `amount` is derived, never supplied. */
export interface PlannedEventUpdate {
  id: string
  price: number
  amount: number
  creditDebit: CreditDebit
  occurredAt: string
  /**
   * v2.12 — true when the stored event was a `schwab_fill` and this edit
   * overrides it. The DB layer must set `source = 'manual'` for these while
   * leaving `schwab_order_id` intact: the number is now typed, but it still
   * came from that order.
   */
  demoteToManual: boolean
}

/**
 * True when this event may be repaired through the edit form.
 *
 * v2.12 — source is no longer part of the test. A close is a close, whoever
 * wrote it; what stays immutable is EVENT TYPE and STRUCTURE.
 */
export function isEditableCloseEvent(ev: TradeEvent): boolean {
  return ev.eventType === 'close'
}

/**
 * Turns patches into row updates, or throws with an operator-readable reason.
 *
 * `existing` must be the trade's FULL event log (the same list the totals are
 * derived from), so an id belonging to another trade is caught here rather
 * than by a rowCount surprise mid-transaction.
 */
export function planCloseEdit(
  existing: TradeEvent[],
  patches: CloseEventPatch[],
): PlannedEventUpdate[] {
  const byId = new Map(existing.map((e) => [e.id, e]))
  const seen = new Set<string>()

  return patches.map((p) => {
    if (seen.has(p.id)) {
      throw new Error(`Edit refused: event ${p.id} appears twice in the submission`)
    }
    seen.add(p.id)

    const ev = byId.get(p.id)
    if (!ev) {
      throw new Error(`Edit refused: event ${p.id} is not part of this trade`)
    }
    if (ev.eventType !== 'close') {
      throw new Error(
        `Edit refused: event ${p.id} is a ${ev.eventType} leg — only close legs are editable ` +
          `(entry and roll legs carry live-data provenance)`,
      )
    }
    return {
      id: p.id,
      price: p.price,
      // Contracts come from the stored event, never the client: the edit
      // repairs a price, it cannot resize the position.
      amount: legAmount(p.price, ev.contracts),
      creditDebit: p.creditDebit,
      occurredAt: p.occurredAt,
      // Overriding a Schwab-derived number makes it a typed one. The order id
      // stays, so the audit trail back to the fill is never broken.
      demoteToManual: ev.source === 'schwab_fill',
    }
  })
}

/**
 * The totals the trade WOULD carry after these patches — the edit form's live
 * preview. Shares planCloseEdit with the write path, so the number April sees
 * before saving is the number the transaction computes after it.
 */
export function previewCloseEditTotals(
  existing: TradeEvent[],
  patches: CloseEventPatch[],
): { credit: number; debit: number } {
  const updates = new Map(planCloseEdit(existing, patches).map((u) => [u.id, u]))
  return deriveTotals(
    existing.map((ev) => {
      const u = updates.get(ev.id)
      return u
        ? { amount: u.amount, creditDebit: u.creditDebit }
        : { amount: ev.amount, creditDebit: ev.creditDebit }
    }),
  )
}
