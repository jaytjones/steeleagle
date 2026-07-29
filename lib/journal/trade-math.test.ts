/**
 * Run with:  npx tsx --test trade-math.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveTotals,
  legAmount,
  tally,
  netCredit,
  entryWingWidth,
  profitTargetBuyback,
  isAtProfitTarget,
  realizedPnl,
} from './trade-math'
import type { Leg } from './types'

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

describe('entryWingWidth', () => {
  // LP 560 / SP 565 / SC 580 / LC 585 — symmetric $5-wide wings.
  const condor: { leg: Leg; strike: number }[] = [
    { leg: 'long_put', strike: 560 },
    { leg: 'short_put', strike: 565 },
    { leg: 'short_call', strike: 580 },
    { leg: 'long_call', strike: 585 },
  ]
  it('is the strike width × 100 × contracts', () => {
    assert.equal(entryWingWidth(condor, 1), 500) // 5 × 100 × 1
    assert.equal(entryWingWidth(condor, 3), 1500)
  })
  it('takes the wider side for asymmetric wings', () => {
    const asym = [
      { leg: 'long_put' as Leg, strike: 550 }, // put wing now $15 wide
      { leg: 'short_put' as Leg, strike: 565 },
      { leg: 'short_call' as Leg, strike: 580 },
      { leg: 'long_call' as Leg, strike: 585 }, // call wing $5 wide
    ]
    assert.equal(entryWingWidth(asym, 1), 1500) // max(15, 5) × 100
  })
  it('returns null when a condor leg is missing', () => {
    assert.equal(entryWingWidth(condor.slice(0, 3), 1), null)
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

describe('deriveTotals', () => {
  const ev = (amount: number, creditDebit: 'credit' | 'debit') => ({ amount, creditDebit })

  it('sums the two directions independently', () => {
    const { credit, debit } = deriveTotals([
      ev(180, 'credit'),
      ev(160, 'credit'),
      ev(60, 'debit'),
      ev(40, 'debit'),
    ])
    assert.equal(credit, 340)
    assert.equal(debit, 100)
  })

  it('is zero/zero on an empty log', () => {
    assert.deepEqual(deriveTotals([]), { credit: 0, debit: 0 })
  })

  it('counts $0.00 events without changing a total', () => {
    // An explicitly-zero close leg (worthless long) is a real, recorded event.
    assert.deepEqual(deriveTotals([ev(250, 'credit'), ev(0, 'debit'), ev(0, 'credit')]), {
      credit: 250,
      debit: 0,
    })
  })

  it('rounds accumulated float drift to whole cents', () => {
    const { credit } = deriveTotals([ev(0.1, 'credit'), ev(0.2, 'credit')])
    assert.equal(credit, 0.3)
  })

  // Regression: the SPY 8/14 journal repair (Session 15 §1). Entry was
  // 950 credit / 395 debit; the four close legs are LP +156 cr, SP 331 db,
  // SC 91 db, LC +6 cr. Deriving from the full log must reproduce the
  // repaired trade row exactly — 1112.00 / 817.00, net P&L 295.
  it('reproduces the SPY 8/14 repair from the full event log', () => {
    const log = [
      ev(950, 'credit'), // four entry legs, collapsed
      ev(395, 'debit'),
      ev(156, 'credit'), // LP 700 STC $1.56
      ev(331, 'debit'), // SP 720 BTC $3.31
      ev(91, 'debit'), // SC 770 BTC $0.91
      ev(6, 'credit'), // LC 790 STC $0.06
    ]
    const { credit, debit } = deriveTotals(log)
    assert.equal(credit, 1112)
    assert.equal(debit, 817)
    assert.equal(netCredit({ totalCreditCollected: credit, totalDebitPaid: debit }), 295)
  })
})
