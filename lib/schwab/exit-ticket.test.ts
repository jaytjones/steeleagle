/**
 * Run with:  npx tsx --test lib/schwab/exit-ticket.test.ts
 *
 * GOLDEN FIXTURE: pinned to the REAL GTC NET_DEBIT iron-condor close
 * Schwab recorded for AAPL (orderId 1006748128062, entered 2026-06-13,
 * dumped via scripts/dump-working-orders.ts on 2026-07-24). The fixture
 * below is the POST-relevant projection of that record — read-only echo
 * fields (orderId, status, legId, positionEffect, cusip, closeTime,
 * accountNumber, …) excluded, exactly as order-ticket.test.ts does for
 * the entry side.
 *
 * Structure: AAPL 2026-07-17, LP 255 / SP 270 / SC 310 / LC 325,
 * qty 1, price 1.60. Leg order as Schwab recorded it: SC, LC, SP, LP.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCondorExitTicket,
  computeExitDebit,
  type CondorExitInput,
  type CondorExitTicket,
} from './exit-ticket'
import { currentStructure } from '../journal/current-structure'

// --------------------------------------------------------
// The golden fixture (POST-relevant projection of the live record)
// --------------------------------------------------------
const AAPL_GOLDEN: CondorExitTicket = {
  orderStrategyType: 'SINGLE',
  complexOrderStrategyType: 'IRON_CONDOR',
  orderType: 'NET_DEBIT',
  price: '1.60',
  duration: 'GOOD_TILL_CANCEL',
  session: 'NORMAL',
  quantity: 1,
  orderLegCollection: [
    {
      instruction: 'BUY_TO_CLOSE',
      quantity: 1,
      instrument: { assetType: 'OPTION', symbol: 'AAPL  260717C00310000' },
    },
    {
      instruction: 'SELL_TO_CLOSE',
      quantity: 1,
      instrument: { assetType: 'OPTION', symbol: 'AAPL  260717C00325000' },
    },
    {
      instruction: 'BUY_TO_CLOSE',
      quantity: 1,
      instrument: { assetType: 'OPTION', symbol: 'AAPL  260717P00270000' },
    },
    {
      instruction: 'SELL_TO_CLOSE',
      quantity: 1,
      instrument: { assetType: 'OPTION', symbol: 'AAPL  260717P00255000' },
    },
  ],
}

const AAPL_INPUT: CondorExitInput = {
  symbol: 'AAPL',
  expiration: '2026-07-17',
  longPut: { strike: 255 },
  shortPut: { strike: 270 },
  shortCall: { strike: 310 },
  longCall: { strike: 325 },
}

describe('buildCondorExitTicket — golden fixture', () => {
  it('reproduces the live AAPL GTC close exactly (orderId 1006748128062)', () => {
    const ticket = buildCondorExitTicket(AAPL_INPUT, { quantity: 1, debit: 1.6 })
    assert.deepEqual(ticket, AAPL_GOLDEN)
  })

  it('duration is GOOD_TILL_CANCEL, never "GTC" (draft-spec guess disproved by the dump)', () => {
    const ticket = buildCondorExitTicket(AAPL_INPUT, { quantity: 1, debit: 1.6 })
    assert.equal(ticket.duration, 'GOOD_TILL_CANCEL')
  })

  it('SPY cross-check: OCC symbols match the second live record (1006723418260)', () => {
    // SPY 2026-07-10, LP 680 / SP 700 / SC 760 / LC 780 — from the dump.
    const ticket = buildCondorExitTicket(
      {
        symbol: 'SPY',
        expiration: '2026-07-10',
        longPut: { strike: 680 },
        shortPut: { strike: 700 },
        shortCall: { strike: 760 },
        longCall: { strike: 780 },
      },
      { quantity: 1, debit: 2.35 },
    )
    assert.equal(ticket.price, '2.35')
    assert.deepEqual(
      ticket.orderLegCollection.map((l) => l.instrument.symbol),
      [
        'SPY   260710C00760000',
        'SPY   260710C00780000',
        'SPY   260710P00700000',
        'SPY   260710P00680000',
      ],
    )
    assert.deepEqual(
      ticket.orderLegCollection.map((l) => l.instruction),
      ['BUY_TO_CLOSE', 'SELL_TO_CLOSE', 'BUY_TO_CLOSE', 'SELL_TO_CLOSE'],
    )
  })

  it('multi-contract: order + every leg carry the quantity', () => {
    const ticket = buildCondorExitTicket(AAPL_INPUT, { quantity: 2, debit: 1.6 })
    assert.equal(ticket.quantity, 2)
    assert.ok(ticket.orderLegCollection.every((l) => l.quantity === 2))
  })
})

describe('buildCondorExitTicket — refusals (Schwab will not catch these)', () => {
  it('refuses non-integer / zero quantity', () => {
    assert.throws(() => buildCondorExitTicket(AAPL_INPUT, { quantity: 0, debit: 1.6 }))
    assert.throws(() => buildCondorExitTicket(AAPL_INPUT, { quantity: 1.5, debit: 1.6 }))
  })

  it('refuses out-of-order strikes', () => {
    assert.throws(
      () =>
        buildCondorExitTicket(
          { ...AAPL_INPUT, shortPut: { strike: 250 } }, // SP < LP
          { quantity: 1, debit: 1.6 },
        ),
      /LP < SP < SC < LC/,
    )
  })

  it('refuses zero / negative debit', () => {
    assert.throws(() => buildCondorExitTicket(AAPL_INPUT, { quantity: 1, debit: 0 }))
    assert.throws(() => buildCondorExitTicket(AAPL_INPUT, { quantity: 1, debit: -1 }))
  })

  it('refuses debit ≥ narrower wing (impossible fill)', () => {
    // AAPL wings are both $15 wide.
    assert.throws(
      () => buildCondorExitTicket(AAPL_INPUT, { quantity: 1, debit: 15 }),
      /impossible fill/,
    )
  })
})

describe('computeExitDebit — §4.2 pricing, floor direction pinned', () => {
  it('$223 net credit, 1 contract → $2.23/share → $1.115 → "1.11" (floors)', () => {
    assert.equal(computeExitDebit(223, 0, 1), '1.11')
  })

  it('clean halves stay exact: $180 net, 1 contract → "0.9000" (sub-$1 → 4 dp)', () => {
    assert.equal(computeExitDebit(180, 0, 1), '0.9000')
  })

  it('$150 net, 1 contract → "0.7500" (sub-$1 4 dp — Schwab acceptance is spec §6b open item)', () => {
    assert.equal(computeExitDebit(150, 0, 1), '0.7500')
  })

  it('roll-aware: debits reduce the target ($446 collected, $110 paid, 1 contract → "1.68")', () => {
    // net 336 → 3.36/share → 1.68
    assert.equal(computeExitDebit(446, 110, 1), '1.68')
  })

  it('per-contract normalization: $446 net across 2 contracts → same per-share as $223 on 1', () => {
    assert.equal(computeExitDebit(446, 0, 2), computeExitDebit(223, 0, 1))
  })

  it('refuses non-positive net credit (never price an exit from bad accounting)', () => {
    assert.throws(() => computeExitDebit(100, 100, 1), /net credit must be positive/)
    assert.throws(() => computeExitDebit(100, 150, 1))
  })

  it('refuses bad contract counts', () => {
    assert.throws(() => computeExitDebit(223, 0, 0))
    assert.throws(() => computeExitDebit(223, 0, 1.5))
  })
})

describe('currentStructure → golden ticket (v2.3 leg derivation)', () => {
  // v2.3 replaced exitInputFromOpenEvents with currentStructure(events).
  // The refusal cases now live in lib/journal/current-structure.test.ts; what
  // MUST stay pinned here is the end-to-end join: a structure folded from a
  // real event log still builds the live AAPL golden ticket byte for byte.
  const openEvent = (
    leg: 'long_put' | 'short_put' | 'short_call' | 'long_call',
    strike: number,
  ) => ({
    eventType: 'open' as const,
    leg,
    strike,
    expiration: '2026-07-17',
    occurredAt: '2026-06-13T03:59:16.000Z',
    createdAt: '2026-06-13T03:59:16.000Z',
  })

  const FOUR = [
    openEvent('long_put', 255),
    openEvent('short_put', 270),
    openEvent('short_call', 310),
    openEvent('long_call', 325),
  ]

  it('unrolled log → the same input the deleted deriver produced', () => {
    assert.deepEqual(currentStructure('AAPL', FOUR), AAPL_INPUT)
  })

  it('derived structure builds the golden ticket end-to-end', () => {
    const ticket = buildCondorExitTicket(currentStructure('AAPL', FOUR), {
      quantity: 1,
      debit: 1.6,
    })
    assert.deepEqual(ticket, AAPL_GOLDEN)
  })

  it('a same-expiration roll prices off the ROLLED strikes, not the entry ones', () => {
    // The v2.2 exclusion existed precisely because this used to be wrong.
    const rolled = [
      ...FOUR,
      { eventType: 'roll_close' as const, leg: 'short_put' as const, strike: 270, expiration: '2026-07-17', occurredAt: '2026-07-01T15:00:00.000Z', createdAt: '2026-07-01T15:00:00.000Z' },
      { eventType: 'roll_open' as const, leg: 'short_put' as const, strike: 265, expiration: '2026-07-17', occurredAt: '2026-07-01T15:00:00.000Z', createdAt: '2026-07-01T15:00:01.000Z' },
    ]
    assert.equal(currentStructure('AAPL', rolled).shortPut.strike, 265)
  })
})
