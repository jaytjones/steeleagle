/**
 * Run with:  npx tsx --test lib/journal/close-from-fill.test.ts
 *
 * The order body mirrors the golden AAPL GTC close (1006748128062)
 * promoted to FILLED with synthetic-but-shape-real execution detail —
 * legId-keyed executionLegs, exactly as Schwab's live records carry
 * (see the CANCELED activity blocks in the 2026-07-24 dump).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { closeInputFromFilledExit } from './close-from-fill'
import { CloseTradeSchema } from './types'
import type { SchwabOrderDetail } from '../schwab/orders'

const occ = (u: string, ymd: string, cp: 'C' | 'P', strike: number) =>
  `${u.padEnd(6)}${ymd}${cp}${String(Math.round(strike * 1000)).padStart(8, '0')}`

function filledExit(overrides: Partial<SchwabOrderDetail> = {}): SchwabOrderDetail {
  return {
    orderId: 1006748128062,
    enteredTime: '2026-06-13T03:59:16+0000',
    closeTime: '2026-07-30T15:31:02+0000',
    status: 'FILLED',
    quantity: 1,
    filledQuantity: 1,
    remainingQuantity: 0,
    orderLegCollection: [
      { legId: 1, instrument: { symbol: occ('AAPL', '260717', 'C', 310), putCall: 'CALL' }, instruction: 'BUY_TO_CLOSE', quantity: 1 },
      { legId: 2, instrument: { symbol: occ('AAPL', '260717', 'C', 325), putCall: 'CALL' }, instruction: 'SELL_TO_CLOSE', quantity: 1 },
      { legId: 3, instrument: { symbol: occ('AAPL', '260717', 'P', 270), putCall: 'PUT' }, instruction: 'BUY_TO_CLOSE', quantity: 1 },
      { legId: 4, instrument: { symbol: occ('AAPL', '260717', 'P', 255), putCall: 'PUT' }, instruction: 'SELL_TO_CLOSE', quantity: 1 },
    ],
    orderActivityCollection: [
      {
        executionLegs: [
          { legId: 1, price: 1.42, quantity: 1, time: '2026-07-30T15:31:02+0000' },
          { legId: 2, price: 0.55, quantity: 1, time: '2026-07-30T15:31:02+0000' },
          { legId: 3, price: 1.01, quantity: 1, time: '2026-07-30T15:31:02+0000' },
          { legId: 4, price: 0.28, quantity: 1, time: '2026-07-30T15:31:02+0000' },
        ],
      },
    ],
    ...overrides,
  }
}

describe('closeInputFromFilledExit — happy path', () => {
  it('maps a filled 4-leg exit to close events with real per-leg prices', () => {
    const result = closeInputFromFilledExit(filledExit())
    assert.equal(result.contracts, 1)
    assert.equal(result.occurredAt, new Date('2026-07-30T15:31:02+0000').toISOString())
    assert.equal(result.events.length, 4)

    const byLeg = new Map(result.events.map((e) => [e.leg, e]))
    // BUY_TO_CLOSE = the leg was short = debit; SELL_TO_CLOSE = long = credit.
    assert.deepEqual(
      { ...byLeg.get('short_call') },
      { eventType: 'close', leg: 'short_call', strike: 310, expiration: '2026-07-17', delta: null, price: 1.42, creditDebit: 'debit' },
    )
    assert.equal(byLeg.get('long_call')!.creditDebit, 'credit')
    assert.equal(byLeg.get('long_call')!.price, 0.55)
    assert.equal(byLeg.get('short_put')!.creditDebit, 'debit')
    assert.equal(byLeg.get('long_put')!.creditDebit, 'credit')
    assert.equal(byLeg.get('long_put')!.strike, 255)
  })

  it('multi-execution partial-then-complete fills average by quantity', () => {
    const order = filledExit({
      quantity: 2,
      filledQuantity: 2,
      orderActivityCollection: [
        { executionLegs: [{ legId: 1, price: 1.4, quantity: 1 }, { legId: 2, price: 0.5, quantity: 1 }, { legId: 3, price: 1.0, quantity: 1 }, { legId: 4, price: 0.3, quantity: 1 }] },
        { executionLegs: [{ legId: 1, price: 1.5, quantity: 1 }, { legId: 2, price: 0.6, quantity: 1 }, { legId: 3, price: 1.1, quantity: 1 }, { legId: 4, price: 0.2, quantity: 1 }] },
      ],
    })
    const result = closeInputFromFilledExit(order)
    assert.equal(result.contracts, 2)
    const sc = result.events.find((e) => e.leg === 'short_call')!
    assert.ok(Math.abs(sc.price - 1.45) < 1e-9)
  })

  it('missing closeTime falls back to latest execution time', () => {
    const result = closeInputFromFilledExit(filledExit({ closeTime: undefined }))
    assert.equal(result.occurredAt, new Date('2026-07-30T15:31:02+0000').toISOString())
  })
})

describe('closeInputFromFilledExit — refusals (mirror of recordFillAction)', () => {
  it('refuses non-FILLED status', () => {
    assert.throws(
      () => closeInputFromFilledExit(filledExit({ status: 'WORKING' })),
      /not FILLED/,
    )
  })

  it('refuses partial fill (filled < ordered)', () => {
    assert.throws(
      () => closeInputFromFilledExit(filledExit({ quantity: 2, filledQuantity: 1 })),
      /partial fills are never journaled/,
    )
  })

  it('refuses non-4-leg orders', () => {
    const order = filledExit()
    order.orderLegCollection = order.orderLegCollection!.slice(0, 2)
    assert.throws(() => closeInputFromFilledExit(order), /expected a 4-leg condor close/)
  })

  it('refuses any *_TO_OPEN leg (not a pure close)', () => {
    const order = filledExit()
    order.orderLegCollection![0].instruction = 'SELL_TO_OPEN'
    assert.throws(() => closeInputFromFilledExit(order), /not a pure closing order/)
  })

  it('refuses missing execution detail — never fabricates a price', () => {
    const order = filledExit()
    order.orderActivityCollection![0].executionLegs = order
      .orderActivityCollection![0].executionLegs!.slice(0, 3)
    assert.throws(() => closeInputFromFilledExit(order), /no execution detail .* refusing to journal invented prices/)
  })

  it('refuses duplicate leg roles (two legs mapping to the same role)', () => {
    const order = filledExit()
    // Make leg 2 another BUY_TO_CLOSE call → two short_call roles.
    order.orderLegCollection![1].instruction = 'BUY_TO_CLOSE'
    assert.throws(() => closeInputFromFilledExit(order), /maps two legs to short_call/)
  })

  it('refuses unparseable OCC symbols', () => {
    const order = filledExit()
    order.orderLegCollection![2].instrument.symbol = 'GARBAGE'
    assert.throws(() => closeInputFromFilledExit(order), /unparseable OCC symbol/)
  })

  it('refuses zero filled quantity', () => {
    assert.throws(
      () => closeInputFromFilledExit(filledExit({ quantity: 0, filledQuantity: 0 })),
      /no filled quantity/,
    )
  })
})

// v2.2.1 — the live sweep does CloseTradeSchema.parse(mapper output) before
// writing (cron route §a). The hardened schema (exactly 4 legs, each role
// once, every price explicit) must not refuse the reconcile path — a refusal
// here would silently stop the auto-exit sweep from journaling real fills.
describe('closeInputFromFilledExit → hardened CloseTradeSchema', () => {
  it('the sweep’s reconcile payload still parses', () => {
    const fill = closeInputFromFilledExit(filledExit())
    const parsed = CloseTradeSchema.safeParse({
      occurredAt: fill.occurredAt,
      closeReason: 'profit_target',
      events: fill.events,
    })
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues))
    assert.equal(parsed.data.events.length, 4)
  })

  it('parses a fill that legitimately closed a leg at $0.00', () => {
    const order = filledExit()
    order.orderActivityCollection![0].executionLegs![1].price = 0
    const fill = closeInputFromFilledExit(order)
    const parsed = CloseTradeSchema.safeParse({
      occurredAt: fill.occurredAt,
      closeReason: 'profit_target',
      events: fill.events,
    })
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues))
  })
})
