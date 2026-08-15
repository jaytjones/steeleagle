import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { lastExecutionTime, orderEffect, sumEffects } from './order-effects'
import { GOLDEN_FILLS } from './golden-fills.fixture'
import type { SchwabOrderDetail } from '../schwab/orders'

const { SPY_SPLIT_CLOSE, SPY_SPLIT_OPEN, GLD_ROLL_TWO_LOT, SPY_BUTTERFLY_CLOSE, GLD_ENTRY } =
  GOLDEN_FILLS

describe('orderEffect — the sign rule (BUY +q, SELL −q, regardless of open/close)', () => {
  it('an entry acquires shorts and longs', () => {
    const e = orderEffect(GLD_ENTRY)
    assert.equal(e.symbols.get('GLD   260918C00400000'), -1) // SELL_TO_OPEN
    assert.equal(e.symbols.get('GLD   260918C00420000'), 1) // BUY_TO_OPEN
    assert.equal(e.symbols.get('GLD   260918P00350000'), -1) // SELL_TO_OPEN
    assert.equal(e.symbols.get('GLD   260918P00330000'), 1) // BUY_TO_OPEN
    assert.deepEqual(e.refusals, [])
  })

  it('a close is the exact mirror of the entry it retires', () => {
    const e = orderEffect(SPY_BUTTERFLY_CLOSE)
    assert.equal(e.symbols.get('SPY   260828C00765000'), 1) // BUY_TO_CLOSE retires a short
    assert.equal(e.symbols.get('SPY   260828C00785000'), -1) // SELL_TO_CLOSE retires a long
    assert.equal(e.symbols.get('SPY   260828P00765000'), 1)
    assert.equal(e.symbols.get('SPY   260828P00745000'), -1)
  })

  it('BUY_TO_CLOSE still RAISES the signed quantity — no open/close case analysis', () => {
    const e = orderEffect(SPY_SPLIT_CLOSE)
    assert.equal(e.symbols.get('SPY   260911P00750000'), 1) // BUY_TO_CLOSE
    assert.equal(e.symbols.get('SPY   260911P00735000'), -1) // SELL_TO_CLOSE
  })

  it('carries multi-lot quantities from the executions', () => {
    const e = orderEffect(GLD_ROLL_TWO_LOT)
    assert.equal(e.symbols.get('GLD   260918P00395000'), -2)
    assert.equal(e.symbols.get('GLD   260918P00385000'), 2)
    assert.equal(e.symbols.get('GLD   260918P00375000'), 2)
    assert.equal(e.symbols.get('GLD   260918P00365000'), -2)
  })
})

describe('orderEffect — effects come from EXECUTIONS, never from requested quantity', () => {
  it('a REJECTED order moves NOTHING even though its legs ask for a close', () => {
    // The GLD streak (Aug 3–13 2026): nine rejected closes that asked for a
    // position change and made none. Reading `orderLegCollection[].quantity`
    // would credit every one of them with an effect that never happened.
    const rejected: SchwabOrderDetail = {
      ...SPY_BUTTERFLY_CLOSE,
      orderId: 1007589853770,
      status: 'REJECTED',
      filledQuantity: 0,
      orderActivityCollection: [],
    }
    const e = orderEffect(rejected)
    assert.equal(e.symbols.size, 0)
    assert.deepEqual(e.refusals, [])
  })

  it('a WORKING GTC moves nothing', () => {
    const working: SchwabOrderDetail = {
      ...SPY_BUTTERFLY_CLOSE,
      status: 'WORKING',
      filledQuantity: 0,
      orderActivityCollection: [],
    }
    assert.equal(orderEffect(working).symbols.size, 0)
  })

  it('a PARTIAL fill contributes its PARTIAL effect — those contracts really moved', () => {
    const partial: SchwabOrderDetail = {
      ...GLD_ROLL_TWO_LOT,
      status: 'PARTIALLY_FILLED',
      filledQuantity: 1,
      orderActivityCollection: [
        {
          executionLegs: [
            { legId: 1, quantity: 1, price: 6.83, time: '2026-08-14T16:04:15+0000' },
            { legId: 2, quantity: 1, price: 3.88, time: '2026-08-14T16:04:15+0000' },
          ],
        },
      ],
    }
    const e = orderEffect(partial)
    assert.equal(e.symbols.get('GLD   260918P00395000'), -1)
    assert.equal(e.symbols.get('GLD   260918P00385000'), 1)
    assert.equal(e.symbols.size, 2, 'unexecuted legs contribute nothing')
  })

  it('status is never read — the same legs with any status give the same effect', () => {
    for (const status of ['FILLED', 'CANCELED', 'REPLACED', undefined]) {
      const e = orderEffect({ ...SPY_SPLIT_CLOSE, status } as SchwabOrderDetail)
      assert.equal(e.symbols.get('SPY   260911P00750000'), 1, String(status))
    }
  })
})

describe('orderEffect — refusals', () => {
  it('an execution leg with no matching order leg REFUSES rather than dropping silently', () => {
    // Contracts demonstrably moved but the direction is unknown. Dropping it
    // would surface downstream as a residual blamed on the account.
    const orphan: SchwabOrderDetail = {
      ...SPY_SPLIT_CLOSE,
      orderActivityCollection: [
        { executionLegs: [{ legId: 99, quantity: 1, price: 3.14, time: '2026-08-14T15:59:26+0000' }] },
      ],
    }
    const e = orderEffect(orphan)
    assert.equal(e.refusals.length, 1)
    assert.match(e.refusals[0], /no matching order leg/)
    assert.equal(e.symbols.size, 0)
  })

  it('a leg with no instruction is refused', () => {
    const noInstruction: SchwabOrderDetail = {
      ...SPY_SPLIT_CLOSE,
      orderLegCollection: [
        { legId: 1, instruction: '', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00750000' } },
        SPY_SPLIT_CLOSE.orderLegCollection![1],
      ],
    }
    const e = orderEffect(noInstruction)
    assert.equal(e.refusals.length, 2) // the bad leg, then its orphaned execution
    assert.match(e.refusals[0], /no instruction/)
  })

  it('never throws on a malformed order', () => {
    assert.doesNotThrow(() => orderEffect({ orderId: 1, enteredTime: '' } as SchwabOrderDetail))
  })
})

describe('sumEffects', () => {
  it('nets the two halves of the real split roll', () => {
    const s = sumEffects([SPY_SPLIT_CLOSE, SPY_SPLIT_OPEN])
    assert.equal(s.symbols.get('SPY   260911P00735000'), -1) // sold out of the old long
    assert.equal(s.symbols.get('SPY   260911P00750000'), 2) // short 1 → long 1
    assert.equal(s.symbols.get('SPY   260911P00765000'), -1) // new short
    assert.deepEqual(s.refusals, [])
    assert.deepEqual(s.contributingOrderIds, ['1007598808689', '1007598809002'])
  })

  it('excludes non-contributing orders from contributingOrderIds', () => {
    const rejected: SchwabOrderDetail = {
      ...SPY_BUTTERFLY_CLOSE,
      orderId: 999,
      orderActivityCollection: [],
    }
    const s = sumEffects([SPY_SPLIT_CLOSE, rejected])
    assert.deepEqual(s.contributingOrderIds, ['1007598808689'])
  })

  it('propagates refusals from any order in the interval', () => {
    const orphan: SchwabOrderDetail = {
      ...SPY_SPLIT_CLOSE,
      orderId: 5,
      orderActivityCollection: [{ executionLegs: [{ legId: 99, quantity: 1, price: 1 }] }],
    }
    assert.equal(sumEffects([SPY_SPLIT_OPEN, orphan]).refusals.length, 1)
  })

  it('an empty interval nets to nothing', () => {
    const s = sumEffects([])
    assert.equal(s.symbols.size, 0)
    assert.deepEqual(s.refusals, [])
  })
})

describe('lastExecutionTime', () => {
  it('returns the latest execution timestamp', () => {
    assert.equal(lastExecutionTime(SPY_SPLIT_OPEN), '2026-08-14T16:03:54+0000')
  })

  it('is null when nothing executed — an interval cannot be bound by a non-fill', () => {
    assert.equal(
      lastExecutionTime({ ...SPY_SPLIT_OPEN, orderActivityCollection: [] } as SchwabOrderDetail),
      null,
    )
  })
})
