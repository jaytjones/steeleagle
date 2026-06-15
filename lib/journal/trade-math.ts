// ============================================================
// SteelEagle — Trade Journal money math (pure, deterministic)
//
// One source of truth for credit/debit accounting so the entry form,
// the DB layer, and the card all agree. Net credit is always derived
// (total_credit_collected - total_debit_paid), never stored — so it
// stays correct no matter how many rolls have happened (addendum §A2).
// ============================================================

import type { CreditDebit, Trade } from './types'

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
