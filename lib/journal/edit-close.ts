// ============================================================
// SteelEagle — v2.2.1 closed-trade edit planner (pure — no I/O)
//
// Decides what an edit is allowed to touch and what each touched row
// becomes. The DB layer only executes the plan; every refusal lives here.
//
// Editable = a `close` event with source 'manual', and only its price /
// direction / timestamp. Everything else is refused, loudly:
//   - `open` / `roll_open` / `roll_close` events — entry and roll legs carry
//     live-data provenance (April's explicit rule). Editing a roll_close on
//     an open trade would also desync the standing GTC's 50% target.
//   - anything source 'schwab_fill' — that is Schwab's record of a real
//     execution, not a typed number.
//   - structure (leg / strike / expiration / contracts) — an edit repairs a
//     mis-keyed fill, it never restates the position.
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
}

/** True when this event may be repaired through the edit form. */
export function isEditableCloseEvent(ev: TradeEvent): boolean {
  return ev.eventType === 'close' && ev.source === 'manual'
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
    if (ev.source !== 'manual') {
      throw new Error(
        `Edit refused: event ${p.id} came from a Schwab fill (order ${ev.schwabOrderId ?? 'unknown'}) — ` +
          `that is Schwab's record of a real execution and is not editable`,
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
