// ============================================================
// SteelEagle — Trade Journal money math (pure, deterministic)
//
// One source of truth for credit/debit accounting so the entry form,
// the DB layer, and the card all agree. Net credit is always derived
// (total_credit_collected - total_debit_paid), never stored — so it
// stays correct no matter how many rolls have happened (addendum §A2).
// ============================================================

import type { CreditDebit, Leg, Trade } from './types'

/** Round to whole cents to keep numeric(10,2) round-trips exact. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Dollar amount of one leg: per-share price × 100 × contracts. Always positive. */
export function legAmount(pricePerShare: number, contracts: number): number {
  return round2(pricePerShare * 100 * contracts)
}

/** A leg as priced by the operator — the minimum shape the tally needs. */
export interface PricedLeg {
  price: number
  creditDebit: CreditDebit
}

/**
 * Split a set of legs into total credit received and total debit paid,
 * all in real dollars for the given contract count.
 */
export function tally(
  legs: PricedLeg[],
  contracts: number,
): { credit: number; debit: number } {
  let credit = 0
  let debit = 0
  for (const l of legs) {
    const amt = legAmount(l.price, contracts)
    if (l.creditDebit === 'credit') credit += amt
    else debit += amt
  }
  return { credit: round2(credit), debit: round2(debit) }
}

/** An event as stored: a positive `amount` plus the direction that signs it. */
export interface AmountedEvent {
  amount: number
  creditDebit: CreditDebit
}

/**
 * v2.2.1 — the trade-level running totals, derived from the FULL event log.
 *
 * This is the Session 15 repair's FILTER-sum as a tested function: totals are
 * never patched incrementally after an edit, they are recomputed from every
 * event the trade has (open + roll_close + roll_open + close). Feed it the
 * whole log, not a slice — a partial list silently understates a total.
 *
 * Sums stored `amount` (not price × 100 × contracts) so a per-event contract
 * count that differs from the trade's is honoured, exactly as the SQL did.
 */
export function deriveTotals(events: AmountedEvent[]): {
  credit: number
  debit: number
} {
  let credit = 0
  let debit = 0
  for (const e of events) {
    if (e.creditDebit === 'credit') credit += e.amount
    else debit += e.amount
  }
  return { credit: round2(credit), debit: round2(debit) }
}

/**
 * Dollar wing width of the condor's entry: the wider of the put-spread and
 * call-spread strike widths × 100 × contracts. This is the structure's risk
 * width (max loss = wing width − net credit); the wider side is taken so an
 * asymmetric roll is reported conservatively, matching reconstruct-positions.
 * Returns null when the four condor legs aren't all present.
 */
export function entryWingWidth(
  legs: { leg: Leg; strike: number }[],
  contracts: number,
): number | null {
  const strikeOf = (l: Leg) => legs.find((x) => x.leg === l)?.strike
  const lp = strikeOf('long_put')
  const sp = strikeOf('short_put')
  const sc = strikeOf('short_call')
  const lc = strikeOf('long_call')
  if (lp == null || sp == null || sc == null || lc == null) return null
  const putWidth = Math.abs(sp - lp)
  const callWidth = Math.abs(lc - sc)
  return round2(Math.max(putWidth, callWidth) * 100 * contracts)
}

/** An entry leg as the operator has typed it, once every field is filled in. */
export interface EntryLeg {
  leg: Leg
  strike: number
  price: number
  creditDebit: CreditDebit
}

/**
 * Buying-power reduction of a condor entry, the strategy way:
 * wider wing × 100 × contracts − net credit collected. The same formula the
 * at-fill path (`recordFillAction`) and the Monitor's reconstructed positions
 * already use, so a hand-journaled trade no longer carries a figure JJ worked
 * out on a calculator while the other two paths computed it.
 *
 * Returns null — never a guess — when any of the four legs is missing a strike
 * or a price, or when the arithmetic comes out at or below zero. A credit that
 * exceeds the wing width is not a condor that was entered, it is a typo, and
 * the field is better left blank for `enteredBpr` to refuse than filled with
 * a number that reads as plausible.
 */
export function entryBpr(legs: EntryLeg[], contracts: number): number | null {
  if (!Number.isInteger(contracts) || contracts <= 0) return null
  const wing = entryWingWidth(legs, contracts)
  if (wing === null) return null
  const { credit, debit } = tally(legs, contracts)
  const bpr = round2(wing - (credit - debit))
  return bpr > 0 ? bpr : null
}

/** Net credit currently at risk: everything collected minus everything paid. */
export function netCredit(trade: Pick<Trade, 'totalCreditCollected' | 'totalDebitPaid'>): number {
  return round2(trade.totalCreditCollected - trade.totalDebitPaid)
}

/**
 * The 50%-profit buy-back target in dollars: close when you can buy the
 * structure back for ≤ half the net credit collected (strategy §profit-target).
 */
export function profitTargetBuyback(net: number): number {
  return round2(net * 0.5)
}

/**
 * True when the current cost to close (debit to buy everything back) has
 * fallen to or below the 50% target — i.e. you've captured ≥ 50% of the credit.
 */
export function isAtProfitTarget(
  trade: Pick<Trade, 'totalCreditCollected' | 'totalDebitPaid'>,
  costToCloseNow: number,
): boolean {
  const net = netCredit(trade)
  if (net <= 0) return false
  return costToCloseNow <= profitTargetBuyback(net)
}

/**
 * Realized P&L of a closed trade: net credit kept after all debits.
 * For an open trade this is the running net credit (mark-to-market excluded —
 * that needs a live Schwab quote the journal doesn't store).
 */
export function realizedPnl(
  trade: Pick<Trade, 'totalCreditCollected' | 'totalDebitPaid'>,
): number {
  return netCredit(trade)
}
