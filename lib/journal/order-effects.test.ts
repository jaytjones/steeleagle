import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { lastExecutionTime, orderEffect, sumEffects } from './order-effects'
import { GOLDEN_FILLS } from './golden-fills.fixture'
import type { SchwabOrderDetail } from '../schwab/orders'

const {
  SPY_SPLIT_CLOSE,
  SPY_SPLIT_OPEN,
  GLD_ROLL_TWO_LOT,
  SPY_BUTTERFLY_CLOSE,
  GLD_ENTRY,
  SWVXX_CASH_SWEEP,
} = GOLDEN_FILLS

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
          executionType: 'FILL',
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

  it('the order-level STATUS is never read — executionType is the discriminator', () => {
    // Still true, and worth pinning: what changed in the cancel fix is that
    // the ACTIVITY's own label is now read. The order's status remains
    // irrelevant, so there is no status table to keep in sync.

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
        { executionType: 'FILL', executionLegs: [{ legId: 99, quantity: 1, price: 3.14, time: '2026-08-14T15:59:26+0000' }] },
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

describe('orderEffect — scope: a non-OPTION leg is OUT OF SCOPE, not unknown', () => {
  // The 2026-08-20 defect. Five SWVXX money-market orders standing in the
  // 180-day window refused on every execution leg, so `checkBalance` returned
  // UNRELIABLE for both of v2.11's first real cron runs and the completeness
  // proof could never have been obtained. Schwab's sweep fund trades
  // continuously — this was the steady state, not an edge case.
  it('a MUTUAL_FUND cash sweep contributes NOTHING and refuses NOTHING', () => {
    const e = orderEffect(SWVXX_CASH_SWEEP)
    assert.equal(e.symbols.size, 0)
    assert.deepEqual(e.refusals, [])
  })

  it('its fractional quantity never reaches the contract arithmetic', () => {
    // 4167.68 is a dollar-denominated fund quantity, not a contract count.
    const e = orderEffect(SWVXX_CASH_SWEEP)
    for (const qty of e.symbols.values()) assert.ok(Number.isInteger(qty))
    assert.equal(e.symbols.size, 0)
  })

  it('is out of scope inside a window too — it settles days after entry', () => {
    // Entered 04-18, executed 04-21: a mutual fund straddles intervals that an
    // option fill never would. Out-of-scope must not depend on the window.
    const window = {
      from: new Date('2026-04-20T00:00:00Z'),
      to: new Date('2026-04-22T00:00:00Z'),
    }
    const e = orderEffect(SWVXX_CASH_SWEEP, window)
    assert.equal(e.symbols.size, 0)
    assert.deepEqual(e.refusals, [])
  })

  it('one cash sweep cannot make a real interval UNRELIABLE', () => {
    // The live shape: option orders that balance, plus the sweep noise.
    const s = sumEffects([SPY_SPLIT_CLOSE, SWVXX_CASH_SWEEP, SPY_SPLIT_OPEN])
    assert.deepEqual(s.refusals, [])
    assert.deepEqual(s.contributingOrderIds, ['1007598808689', '1007598809002'])
  })

  it('a MIXED order still signs its option legs and ignores the rest', () => {
    // Defensive: scope is decided per LEG, never per order.
    const mixed: SchwabOrderDetail = {
      ...SPY_SPLIT_CLOSE,
      orderLegCollection: [
        ...SPY_SPLIT_CLOSE.orderLegCollection!,
        { legId: 9, instruction: 'BUY', quantity: 100, instrument: { assetType: 'EQUITY', symbol: 'SPY' } },
      ],
      orderActivityCollection: [
        {
          executionType: 'FILL',
          executionLegs: [
            ...SPY_SPLIT_CLOSE.orderActivityCollection![0].executionLegs!,
            { legId: 9, quantity: 100, price: 640, time: '2026-08-14T15:59:26+0000' },
          ],
        },
      ],
    }
    const e = orderEffect(mixed)
    assert.deepEqual(e.refusals, [])
    assert.equal(e.symbols.get('SPY   260911P00750000'), 1)
    assert.equal(e.symbols.has('SPY'), false)
  })

  it('an ABSENT leg is still a refusal — the distinction is the whole fix', () => {
    // Out of scope must not become a licence to drop genuinely unknown legs.
    const orphanAlongsideSweep: SchwabOrderDetail = {
      ...SWVXX_CASH_SWEEP,
      orderActivityCollection: [
        {
          executionType: 'FILL',
          executionLegs: [
            { legId: 1, quantity: 4167.68, price: 1, time: '2026-04-21T00:46:46+0000' },
            { legId: 77, quantity: 1, price: 1, time: '2026-04-21T00:46:46+0000' },
          ],
        },
      ],
    }
    const e = orderEffect(orphanAlongsideSweep)
    assert.equal(e.refusals.length, 1)
    assert.match(e.refusals[0], /no matching order leg/)
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
      orderActivityCollection: [{ executionType: 'FILL', executionLegs: [{ legId: 99, quantity: 1, price: 1 }] }],
    }
    assert.equal(sumEffects([SPY_SPLIT_OPEN, orphan]).refusals.length, 1)
  })

  it('an empty interval nets to nothing', () => {
    const s = sumEffects([])
    assert.equal(s.symbols.size, 0)
    assert.deepEqual(s.refusals, [])
  })
})

describe('sumEffects — the execution window (spec §6, the boundary case)', () => {
  // The split roll: close executed 15:59:26Z, open executed 16:03:54Z.
  const both = [SPY_SPLIT_CLOSE, SPY_SPLIT_OPEN]

  it('includes only executions inside (from, to]', () => {
    const s = sumEffects(both, {
      from: new Date('2026-08-14T16:00:00Z'),
      to: new Date('2026-08-14T17:00:00Z'),
    })
    // The 15:59:26 close falls before `from` and must be excluded entirely.
    assert.equal(s.symbols.get('SPY   260911P00735000'), undefined)
    assert.equal(s.symbols.get('SPY   260911P00765000'), -1)
    assert.equal(s.symbols.get('SPY   260911P00750000'), 1) // open leg only
  })

  it('is half-open: an execution exactly at `from` is EXCLUDED', () => {
    // It belongs to the previous interval, already baked into that anchor.
    const s = sumEffects([SPY_SPLIT_CLOSE], {
      from: new Date('2026-08-14T15:59:26Z'),
      to: new Date('2026-08-14T17:00:00Z'),
    })
    assert.equal(s.symbols.size, 0)
  })

  it('is half-open: an execution exactly at `to` is INCLUDED', () => {
    const s = sumEffects([SPY_SPLIT_CLOSE], {
      from: new Date('2026-08-14T15:00:00Z'),
      to: new Date('2026-08-14T15:59:26Z'),
    })
    assert.equal(s.symbols.get('SPY   260911P00750000'), 1)
  })

  it('a fill STRADDLING the boundary counts only its in-window contracts', () => {
    // This is why executions are filtered individually rather than whole
    // orders: a GTC that partially filled yesterday and completed today is ONE
    // order whose earlier contracts are already in the anchor. Counting the
    // whole order would leave a phantom residual on BOTH days.
    const straddling: SchwabOrderDetail = {
      ...GLD_ROLL_TWO_LOT,
      orderActivityCollection: [
        { executionType: 'FILL', executionLegs: [{ legId: 1, quantity: 1, price: 6.83, time: '2026-08-13T20:00:00+0000' }] },
        { executionType: 'FILL', executionLegs: [{ legId: 1, quantity: 1, price: 6.83, time: '2026-08-14T16:04:15+0000' }] },
      ],
    }
    const s = sumEffects([straddling], {
      from: new Date('2026-08-14T00:00:00Z'),
      to: new Date('2026-08-14T23:00:00Z'),
    })
    assert.equal(s.symbols.get('GLD   260918P00395000'), -1, 'only today’s single contract')
  })

  it('an execution with NO timestamp REFUSES rather than being guessed either way', () => {
    const noTime: SchwabOrderDetail = {
      ...SPY_SPLIT_CLOSE,
      orderActivityCollection: [{ executionType: 'FILL', executionLegs: [{ legId: 1, quantity: 1, price: 3.14 }] }],
    }
    const s = sumEffects([noTime], {
      from: new Date('2026-08-14T00:00:00Z'),
      to: new Date('2026-08-14T23:00:00Z'),
    })
    assert.equal(s.refusals.length, 1)
    assert.match(s.refusals[0], /no timestamp/)
    assert.equal(s.symbols.size, 0)
  })

  it('with NO window every execution counts — the unbounded form is unchanged', () => {
    const s = sumEffects(both)
    assert.equal(s.symbols.get('SPY   260911P00750000'), 2)
  })
})

describe('orderEffect — a CANCELLATION is a known ZERO, not a movement', () => {
  const { SPY_CANCELED_GTC } = GOLDEN_FILLS

  it('the live cancelled GTC contributes NOTHING and refuses NOTHING', () => {
    // Order 1007540494945, the SPY 2026-09-11 exit GTC JJ cancelled on
    // 2026-08-14 to roll. `filledQuantity: 0` — but four execution legs at
    // quantity 1, which this module used to sign as a complete condor close.
    const e = orderEffect(SPY_CANCELED_GTC)
    assert.equal(e.symbols.size, 0, 'a cancellation moved no contracts')
    assert.deepEqual(e.refusals, [], 'and it is KNOWN to have moved none — D2')
  })

  it('the phantom it used to produce was a whole four-leg condor', () => {
    // What the bug looked like, asserted from the fixture rather than
    // described: read the legs without the executionType guard and every one
    // signs. This is the shape that reached the identity.
    const legs = SPY_CANCELED_GTC.orderActivityCollection![0].executionLegs!
    assert.equal(legs.length, 4)
    assert.ok(legs.every((l) => (l.quantity ?? 0) > 0), 'non-zero, so a quantity guard cannot catch it')
    assert.ok(legs.every((l) => l.price === 0))
  })

  it('a REPLACED order DOUBLES real movement — the dangerous half', () => {
    // A replacement's cancel record repeats the legs the replacement then
    // fills. Both counted, the identity reads twice the traded quantity: on
    // the 2026-08-14 split-roll morning that was GLD ±4 where ±2 traded.
    const replaced: SchwabOrderDetail = {
      ...SPY_SPLIT_CLOSE,
      status: 'REPLACED',
      orderActivityCollection: [
        { activityType: 'EXECUTION', executionType: 'CANCELED', executionLegs: SPY_SPLIT_CLOSE.orderActivityCollection![0].executionLegs },
      ],
    }
    const fill = orderEffect(SPY_SPLIT_CLOSE)
    const dead = orderEffect(replaced)
    assert.equal(fill.symbols.get('SPY   260911P00750000'), 1)
    assert.equal(dead.symbols.size, 0, 'the replaced original moved nothing')
  })

  it('a PARTIAL fill then a cancel counts the fill and only the fill', () => {
    // Schwab files both records on the same order. The contracts that traded
    // are real; the cancelled remainder is not.
    const partial: SchwabOrderDetail = {
      ...GLD_ROLL_TWO_LOT,
      status: 'CANCELED',
      orderActivityCollection: [
        { executionType: 'FILL', executionLegs: [{ legId: 1, quantity: 1, price: 6.83, time: '2026-08-14T16:04:15+0000' }] },
        { executionType: 'CANCELED', executionLegs: [{ legId: 1, quantity: 1, price: 0, time: '2026-08-14T16:30:00+0000' }] },
      ],
    }
    const e = orderEffect(partial)
    const symbol = GLD_ROLL_TWO_LOT.orderLegCollection![0].instrument.symbol
    assert.equal(Math.abs(e.symbols.get(symbol) ?? 0), 1, 'one contract traded, not two')
    assert.deepEqual(e.refusals, [])
  })

  it('an UNRECOGNISED executionType REFUSES — in scope but unknown', () => {
    // The inverse guard. Folding UNKNOWN into "moved nothing" would let a
    // future Schwab label silently delete real contracts from the proof.
    const odd: SchwabOrderDetail = {
      ...SPY_SPLIT_CLOSE,
      orderActivityCollection: [
        { executionType: 'SOMETHING_NEW', executionLegs: SPY_SPLIT_CLOSE.orderActivityCollection![0].executionLegs },
      ],
    }
    const e = orderEffect(odd)
    assert.equal(e.symbols.size, 0)
    assert.equal(e.refusals.length, 1)
    assert.match(e.refusals[0], /SOMETHING_NEW/)
  })

  it('an ABSENT executionType also refuses — never assumed to be a fill', () => {
    const bare: SchwabOrderDetail = {
      ...SPY_SPLIT_CLOSE,
      orderActivityCollection: [
        { executionLegs: SPY_SPLIT_CLOSE.orderActivityCollection![0].executionLegs },
      ],
    }
    const e = orderEffect(bare)
    assert.equal(e.refusals.length, 1)
    assert.match(e.refusals[0], /\(absent\)/)
  })

  it('lastExecutionTime ignores a cancellation — an interval is bound by FILLS', () => {
    assert.equal(lastExecutionTime(SPY_CANCELED_GTC), null)
  })

  it('sumEffects over an interval containing ONLY a cancellation is empty and reliable', () => {
    // The whole point. This interval used to come back with four phantom legs,
    // which balance.ts renders as an UNEXPLAINED residual — and v2.11 step 8's
    // auto-write gate is bounded by a ZERO residual, so it could never open on
    // any day JJ cancelled a GTC.
    const s = sumEffects([SPY_CANCELED_GTC], {
      from: new Date('2026-08-14T00:00:00Z'),
      to: new Date('2026-08-15T00:00:00Z'),
    })
    assert.equal(s.symbols.size, 0)
    assert.deepEqual(s.refusals, [])
    assert.deepEqual(s.contributingOrderIds, [])
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
