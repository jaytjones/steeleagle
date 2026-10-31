// ============================================================
// SteelEagle — v2.16 roll-price edit planner (pure — no I/O)
//
// v2.15 §8.1 option (b), decided by JJ: roll legs become repairable, PRICES
// ONLY. Until this existed, a roll the sweep journaled automatically (v2.15)
// could only be fixed by hand-written SQL — the same gap v2.12 closed for
// closes. Spec: docs/steeleagle-v2-16-spec.md §1.
//
// ── Why prices only ──
//
//   credit/debit  — on a roll it is fixed by the instruction (BUY pays, SELL
//                   collects: the F3 table). A wrong direction means a wrong
//                   ROLE, and that is structure.
//   occurredAt    — the fold batches a roll by occurredAt. Editing one leg's
//                   time splits the batch and changes what currentStructure
//                   reconstructs: a "price fix" that silently restates the
//                   position.
//   leg / strike / expiration / contracts — structure, immutable, as with
//                   closes (v2.2.1).
//
// ── The standing-GTC refusal (JJ, 2026-10-31) ──
//
// edit-close.ts kept rolls out because "editing a roll_close on an open trade
// would also desync the standing GTC's 50% target". That hazard is real: the
// cron never cancels or re-prices a working order, so a price edit under a
// live GTC would leave Schwab holding a close priced from the OLD credit until
// it filled. So an edit on a trade with `exit_order_id` set REFUSES. JJ cancels
// the GTC from the Monitor, edits, and the next sweep places it at the
// corrected price. A HELD trade (v2.15) has no GTC by construction — editing
// there is the designed repair before confirming.
//
// ── Provenance: the v2.12 rule, unchanged ──
//
// A `schwab_fill` leg edited by hand is demoted to `source = 'manual'` and
// KEEPS `schwab_order_id`. The order id says which fill the leg came from;
// `source` says where the NUMBER came from. The v2.15 AUTO tag keys on the
// order id, so it still marks the legs after a repair.
// ============================================================

import { deriveTotals, legAmount } from './trade-math'
import type { TradeEvent } from './types'

/** One operator-supplied repair, already zod-validated for shape. */
export interface RollPricePatch {
  id: string
  price: number
}

/** One row the DB layer will UPDATE. `amount` is derived, never supplied. */
export interface PlannedRollPriceUpdate {
  id: string
  price: number
  amount: number
  /** True when the stored leg was `schwab_fill` — becomes `manual`, order id kept. */
  demoteToManual: boolean
}

export function isEditableRollEvent(ev: Pick<TradeEvent, 'eventType'>): boolean {
  return ev.eventType === 'roll_close' || ev.eventType === 'roll_open'
}

/**
 * Turns patches into row updates, or throws with an operator-readable reason.
 * Any ineligible patch refuses the WHOLE edit.
 *
 * @param existing     the trade's FULL event log
 * @param exitOrderId  the trade's standing GTC on record, or null
 */
export function planRollEdit(
  existing: TradeEvent[],
  patches: RollPricePatch[],
  exitOrderId: string | null,
): PlannedRollPriceUpdate[] {
  if (patches.length === 0) throw new Error('Edit refused: no roll legs submitted')

  if (exitOrderId !== null) {
    throw new Error(
      `Edit refused: standing GTC ${exitOrderId} was priced from the current credit, and ` +
        `the sweep never re-prices a working order. Cancel the GTC from the Positions ` +
        `Monitor first — the next sweep places it again at the corrected price.`,
    )
  }

  const byId = new Map(existing.map((e) => [e.id, e]))
  const seen = new Set<string>()

  return patches.map((p) => {
    if (seen.has(p.id)) {
      throw new Error(`Edit refused: event ${p.id} appears twice in the submission`)
    }
    seen.add(p.id)

    const ev = byId.get(p.id)
    if (!ev) throw new Error(`Edit refused: event ${p.id} is not part of this trade`)
    if (!isEditableRollEvent(ev)) {
      throw new Error(
        `Edit refused: event ${p.id} is a ${ev.eventType} leg — this edit repairs roll ` +
          `prices only (closes have their own edit; entry legs are not editable)`,
      )
    }

    return {
      id: p.id,
      price: p.price,
      // Contracts from the stored event, never the client.
      amount: legAmount(p.price, ev.contracts),
      demoteToManual: ev.source === 'schwab_fill',
    }
  })
}

/**
 * The totals the trade WOULD carry after these patches — the form's live
 * preview, through the same planner the write path uses.
 */
export function previewRollEditTotals(
  existing: TradeEvent[],
  patches: RollPricePatch[],
  exitOrderId: string | null,
): { credit: number; debit: number } {
  const updates = new Map(planRollEdit(existing, patches, exitOrderId).map((u) => [u.id, u]))
  return deriveTotals(
    existing.map((ev) => ({
      amount: updates.get(ev.id)?.amount ?? ev.amount,
      creditDebit: ev.creditDebit,
    })),
  )
}
