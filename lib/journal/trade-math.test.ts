/**
 * Run with:  npx tsx --test trade-math.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  legAmount,
  tally,
  netCredit,
  profitTargetBuyback,
  isAtProfitTarget,
  realizedPnl,
} from './trade-math'

describe('legAmount', () => {
  it('is price × 100 × contracts', () => {
    assert.equal(legAmount(1.25, 1), 125)
    assert.equal(legAmount(1.25, 3), 375)
  })
  it('rounds to whole cents', () => {
    assert.equal(legAmount(0.333, 1), 33.3)
  })
})

describe('tally', () => {
  // A standard short iron condor entry: sell the inner strikes (credit),
  // buy the wings (debit). Net = credits - debits.
  const condor = [
    { price: 1.8, creditDebit: 'credit' as const }, // short put
    { price: 0.6, creditDebit: 'debit' as const }, // long put
    { price: 1.6, creditDebit: 'credit' as const }, // short call
    { price: 0.4, creditDebit: 'debit' as const }, // long call
  ]
  it('splits credit and debit across legs (1 contract)', () => {
    const { credit, debit } = tally(condor, 1)
    assert.equal(credit, 340) // (1.8 + 1.6) × 100
    assert.equal(debit, 100) // (0.6 + 0.4) × 100
  })
  it('scales with contracts', () => {
    const { credit, debit } = tally(condor, 2)
    assert.equal(credit, 680)
    assert.equal(debit, 200)
  })
})

describe('netCredit', () => {
  it('is total collected minus total paid', () => {
    assert.equal(netCredit({ totalCreditCollected: 340, totalDebitPaid: 100 }), 240)
  })
  it('stays correct after a roll adds credit and debit', () => {
    // Entry net 240, then a roll: +160 credit collected, +90 debit paid.
    assert.equal(
      netCredit({ totalCreditCollected: 340 + 160, totalDebitPaid: 100 + 90 }),
      310,
    )
  })
})

describe('profitTargetBuyback', () => {
  it('is half the net credit', () => {
    assert.equal(profitTargetBuyback(240), 120)
  })
})

describe('isAtProfitTarget', () => {
  const trade = { totalCreditCollected: 340, totalDebitPaid: 100 } // net 240, target 120
  it('true when cost-to-close has fallen to/below 50%', () => {
    assert.equal(isAtProfitTarget(trade, 120), true)
    assert.equal(isAtProfitTarget(trade, 90), true)
  })
  it('false when it is still expensive to close', () => {
    assert.equal(isAtProfitTarget(trade, 121), false)
  })
  it('false on a net-debit (underwater) position', () => {
    assert.equal(isAtProfitTarget({ totalCreditCollected: 100, totalDebitPaid: 150 }, 0), false)
  })
})

describe('realizedPnl', () => {
  it('equals the net credit kept', () => {
    assert.equal(realizedPnl({ totalCreditCollected: 500, totalDebitPaid: 190 }), 310)
  })
})
