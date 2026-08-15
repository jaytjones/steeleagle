// ============================================================
// SteelEagle — v2.11 classify-fill
//
// Asserted against the seven live payloads in golden-fills.fixture.ts. If a
// test here fails after a refactor, the REFACTOR is wrong — those fixtures are
// Schwab's own records of April's actual trades.
// ============================================================

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { classifyFill, fillLegRole, isLifecycleShape } from './classify-fill'
import { GOLDEN_FILLS } from './golden-fills.fixture'
import type { SchwabOrderDetail } from '../schwab/orders'

const {
  GLD_ENTRY,
  SPY_BUTTERFLY_CLOSE,
  SPY_ROLL_CONDOR,
  SPY_ROLL_CUSTOM,
  GLD_ROLL_TWO_LOT,
  SPY_SPLIT_CLOSE,
  SPY_SPLIT_OPEN,
} = GOLDEN_FILLS

// --------------------------------------------------------

describe('fillLegRole — the F3 four-instruction table', () => {
  it('BUY_TO_CLOSE means the leg WAS short', () => {
    assert.equal(fillLegRole('BUY_TO_CLOSE', 'PUT'), 'short_put')
    assert.equal(fillLegRole('BUY_TO_CLOSE', 'CALL'), 'short_call')
  })

  it('SELL_TO_CLOSE means the leg WAS long', () => {
    assert.equal(fillLegRole('SELL_TO_CLOSE', 'PUT'), 'long_put')
    assert.equal(fillLegRole('SELL_TO_CLOSE', 'CALL'), 'long_call')
  })

  it('SELL_TO_OPEN BECOMES short', () => {
    assert.equal(fillLegRole('SELL_TO_OPEN', 'PUT'), 'short_put')
    assert.equal(fillLegRole('SELL_TO_OPEN', 'CALL'), 'short_call')
  })

  it('BUY_TO_OPEN BECOMES long — the row close-from-fill would get WRONG', () => {
    // `short = startsWith('BUY')` would call these short. They are longs.
    assert.equal(fillLegRole('BUY_TO_OPEN', 'PUT'), 'long_put')
    assert.equal(fillLegRole('BUY_TO_OPEN', 'CALL'), 'long_call')
  })
})

describe('classifyFill — golden fixtures (live payloads, 2026-08-14)', () => {
  it('GLD entry 1007457102802 → CONDOR_OPEN with all four roles', () => {
    const c = classifyFill(GLD_ENTRY)
    assert.equal(c.shape, 'CONDOR_OPEN')
    assert.equal(c.underlying, 'GLD')
    assert.equal(c.expiration, '2026-09-18')
    assert.equal(c.contracts, 1)
    assert.equal(c.filled, true)
    assert.deepEqual(c.refusals, [])
    assert.deepEqual(
      c.legs.map((l) => [l.role, l.strike, l.action, l.price]),
      [
        ['short_call', 400, 'open', 3.72],
        ['long_call', 420, 'open', 1.41],
        ['short_put', 350, 'open', 2.75],
        ['long_put', 330, 'open', 0.92],
      ],
    )
  })

  it('SPY butterfly close 1007514529392 → CONDOR_CLOSE (SP === SC admitted)', () => {
    const c = classifyFill(SPY_BUTTERFLY_CLOSE)
    assert.equal(c.shape, 'CONDOR_CLOSE')
    const sp = c.legs.find((l) => l.role === 'short_put')
    const sc = c.legs.find((l) => l.role === 'short_call')
    // The v2.7 invariant LP < SP <= SC < LC — the `<=` is what admits this.
    assert.equal(sp?.strike, 765)
    assert.equal(sc?.strike, 765)
    assert.deepEqual(c.refusals, [])
  })

  it('SPY roll 1007454721397 (labelled CONDOR) → ROLL', () => {
    const c = classifyFill(SPY_ROLL_CONDOR)
    assert.equal(c.shape, 'ROLL')
    assert.equal(c.complexOrderStrategyType, 'CONDOR')
    assert.deepEqual(
      c.legs.map((l) => [l.action, l.role, l.strike]),
      [
        ['open', 'short_put', 740],
        ['open', 'long_put', 725],
        ['close', 'short_put', 715],
        ['close', 'long_put', 700],
      ],
    )
  })

  it('SPY roll 1007483420023 (labelled CUSTOM) → ROLL — F2, the label is ignored', () => {
    const c = classifyFill(SPY_ROLL_CUSTOM)
    assert.equal(c.shape, 'ROLL')
    assert.equal(c.complexOrderStrategyType, 'CUSTOM')
  })

  it('the CONDOR and CUSTOM rolls classify IDENTICALLY — the F2 proof', () => {
    const a = classifyFill(SPY_ROLL_CONDOR)
    const b = classifyFill(SPY_ROLL_CUSTOM)
    assert.equal(a.shape, b.shape)
    assert.notEqual(a.complexOrderStrategyType, b.complexOrderStrategyType)
    // Same role/action pattern despite the differing Schwab label and leg order.
    const pattern = (c: typeof a) =>
      [...c.legs].map((l) => `${l.action}:${l.role}`).sort().join(',')
    assert.equal(pattern(a), pattern(b))
  })

  it('GLD 2-lot roll 1007598809028 → ROLL carrying contracts 2 per leg', () => {
    const c = classifyFill(GLD_ROLL_TWO_LOT)
    assert.equal(c.shape, 'ROLL')
    assert.equal(c.contracts, 2)
    assert.ok(c.legs.every((l) => l.contracts === 2))
    assert.equal(c.legs.find((l) => l.strike === 395)?.price, 6.83)
  })

  it('every ROLL fixture pairs each roll_open with a roll_close on the same role', () => {
    for (const order of [SPY_ROLL_CONDOR, SPY_ROLL_CUSTOM, GLD_ROLL_TWO_LOT]) {
      const c = classifyFill(order)
      const closed = new Set(c.legs.filter((l) => l.action === 'close').map((l) => l.role))
      const opened = c.legs.filter((l) => l.action === 'open')
      // This is RollTradeSchema's superRefine, checked at the source.
      assert.ok(opened.every((l) => closed.has(l.role)), `order ${c.orderId}`)
    }
  })

  it('split roll: the close leg → PARTIAL_CLOSE', () => {
    const c = classifyFill(SPY_SPLIT_CLOSE)
    assert.equal(c.shape, 'PARTIAL_CLOSE')
    assert.deepEqual(
      c.legs.map((l) => [l.role, l.strike, l.price]),
      [
        ['short_put', 750, 3.14],
        ['long_put', 735, 1.89],
      ],
    )
  })

  it('split roll: the open leg → PARTIAL_OPEN, 4m28s later on the same key', () => {
    const c = classifyFill(SPY_SPLIT_OPEN)
    assert.equal(c.shape, 'PARTIAL_OPEN')
    assert.equal(c.underlying, 'SPY')
    assert.equal(c.expiration, '2026-09-11')
    const gap =
      Date.parse(SPY_SPLIT_OPEN.enteredTime) - Date.parse(SPY_SPLIT_CLOSE.enteredTime)
    assert.equal(gap, 268_000) // 4m28s — the pairing window must accommodate this
  })

  it('neither split-roll half is a ROLL on its own — pairing is match-fill’s job', () => {
    assert.notEqual(classifyFill(SPY_SPLIT_CLOSE).shape, 'ROLL')
    assert.notEqual(classifyFill(SPY_SPLIT_OPEN).shape, 'ROLL')
  })

  it('all seven fixtures are lifecycle shapes with no refusals', () => {
    for (const [name, order] of Object.entries(GOLDEN_FILLS)) {
      const c = classifyFill(order)
      assert.ok(isLifecycleShape(c.shape), `${name} → ${c.shape}`)
      assert.deepEqual(c.refusals, [], name)
    }
  })
})

describe('classifyFill — refusals and edge cases', () => {
  it('classifies a REJECTED order by shape — status independence', () => {
    // The GLD rejection streak (Aug 3–13) is the strongest drift signal the
    // account emits; refusing to classify it would throw that signal away.
    const rejected: SchwabOrderDetail = {
      ...SPY_BUTTERFLY_CLOSE,
      orderId: 1007589853770,
      status: 'REJECTED',
      filledQuantity: 0,
      orderActivityCollection: [],
    }
    const c = classifyFill(rejected)
    assert.equal(c.shape, 'CONDOR_CLOSE')
    assert.equal(c.status, 'REJECTED')
    assert.equal(c.filled, false)
    assert.ok(c.legs.every((l) => l.price === null), 'no executions ⇒ no invented prices')
  })

  it('an unparseable OCC symbol refuses the whole classification', () => {
    const bad: SchwabOrderDetail = {
      ...SPY_SPLIT_CLOSE,
      orderLegCollection: [
        { legId: 1, instruction: 'BUY_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'NOT-AN-OCC-SYMBOL' } },
        SPY_SPLIT_CLOSE.orderLegCollection![1],
      ],
    }
    const c = classifyFill(bad)
    assert.equal(c.shape, 'AMBIGUOUS')
    assert.equal(c.refusals.length, 1)
    assert.match(c.refusals[0], /unparseable OCC symbol/)
  })

  it('an equity-only order is NOT_OPTION, not AMBIGUOUS', () => {
    const equity: SchwabOrderDetail = {
      orderId: 1,
      enteredTime: '2026-08-14T15:00:00+0000',
      status: 'FILLED',
      orderLegCollection: [
        { instruction: 'BUY', quantity: 100, instrument: { assetType: 'EQUITY', symbol: 'SPY' } },
      ],
    }
    assert.equal(classifyFill(equity).shape, 'NOT_OPTION')
  })

  it('a roll that opens a role it did not close is refused', () => {
    const orphan: SchwabOrderDetail = {
      ...SPY_ROLL_CONDOR,
      orderLegCollection: [
        SPY_ROLL_CONDOR.orderLegCollection![0], // SELL_TO_OPEN 740P → short_put
        SPY_ROLL_CONDOR.orderLegCollection![1], // BUY_TO_OPEN  725P → long_put
        SPY_ROLL_CONDOR.orderLegCollection![3], // SELL_TO_CLOSE 700P → long_put only
      ],
    }
    const c = classifyFill(orphan)
    assert.equal(c.shape, 'AMBIGUOUS')
    assert.match(c.refusals[0], /opens short_put without closing it/)
  })

  it('four legs that are not a condor refuse rather than pass as CONDOR_CLOSE', () => {
    // SP > SC — never valid, the v2.7 invariant.
    const crossed: SchwabOrderDetail = {
      ...SPY_BUTTERFLY_CLOSE,
      orderLegCollection: [
        { legId: 1, instruction: 'BUY_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260828C00700000', putCall: 'CALL' } },
        { legId: 2, instruction: 'SELL_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260828C00785000', putCall: 'CALL' } },
        { legId: 3, instruction: 'BUY_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260828P00765000', putCall: 'PUT' } },
        { legId: 4, instruction: 'SELL_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260828P00745000', putCall: 'PUT' } },
      ],
    }
    const c = classifyFill(crossed)
    assert.equal(c.shape, 'AMBIGUOUS')
    assert.match(c.refusals[0], /not a condor/)
  })

  it('a diagonal roll reports a null expiration rather than picking one', () => {
    const diagonal: SchwabOrderDetail = {
      ...SPY_ROLL_CONDOR,
      orderLegCollection: [
        { legId: 1, instruction: 'SELL_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   261016P00740000', putCall: 'PUT' } },
        { legId: 2, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   261016P00725000', putCall: 'PUT' } },
        SPY_ROLL_CONDOR.orderLegCollection![2],
        SPY_ROLL_CONDOR.orderLegCollection![3],
      ],
    }
    const c = classifyFill(diagonal)
    assert.equal(c.shape, 'ROLL')
    assert.equal(c.expiration, null)
    assert.equal(c.underlying, 'SPY')
  })
})

describe('classifyFill — contracts is integer-safe (live defect, 2026-08-14)', () => {
  it('truncates a fractional filledQuantity rather than passing it through', () => {
    // Live order 191708603600 reported filledQuantity 4167.68 — an equity
    // order in dollar terms. It blew up schwab_fills.contracts (integer) on the
    // first ingestion run. NOT_OPTION orders are no longer ledgered, but a
    // malformed OPTION order must still degrade instead of failing the batch.
    const fractional: SchwabOrderDetail = { ...SPY_SPLIT_CLOSE, filledQuantity: 4167.68 }
    assert.equal(classifyFill(fractional).contracts, 4167)
  })

  it('never yields a negative contract count', () => {
    assert.equal(classifyFill({ ...SPY_SPLIT_CLOSE, filledQuantity: -3 }).contracts, 0)
  })

  it('a missing filledQuantity is 0, not NaN', () => {
    assert.equal(classifyFill({ ...SPY_SPLIT_CLOSE, filledQuantity: undefined }).contracts, 0)
  })
})

describe('classifyFill — zero-value executions on dead orders (live defect, 2026-08-14)', () => {
  // Schwab attaches execution records to REPLACED/CANCELED orders that moved
  // nothing: price 0 across every leg. Defaulting a missing quantity to 1 made
  // 13 such orders read as FILLED with contracts 0, and matchFill then reported
  // them as unjournaled work. Confirmed on live orders 1007449913576 (REPLACED),
  // 1007448830387 and 1007468901534 (CANCELED).
  const dead: SchwabOrderDetail = {
    ...SPY_ROLL_CONDOR,
    orderId: 1007449913576,
    status: 'REPLACED',
    filledQuantity: 0,
    orderActivityCollection: [
      {
        executionLegs: [
          { legId: 1, price: 0, time: '2026-08-04T13:32:04+0000' },
          { legId: 2, price: 0, time: '2026-08-04T13:32:04+0000' },
          { legId: 3, price: 0, time: '2026-08-04T13:32:04+0000' },
          { legId: 4, price: 0, time: '2026-08-04T13:32:04+0000' },
        ],
      },
    ],
  }

  it('a REPLACED order with zero-value executions is NOT filled', () => {
    const c = classifyFill(dead)
    assert.equal(c.filled, false, 'an execution record is not an execution')
    assert.equal(c.contracts, 0)
  })

  it('still classifies the SHAPE — a dead order is forensics, not nothing', () => {
    assert.equal(classifyFill(dead).shape, 'ROLL')
  })

  it('invents no prices for legs that never executed', () => {
    assert.ok(classifyFill(dead).legs.every((l) => l.price === null))
  })

  it('an explicit quantity 0 is skipped just as a missing one is', () => {
    const explicit: SchwabOrderDetail = {
      ...dead,
      orderActivityCollection: [
        { executionLegs: [{ legId: 1, quantity: 0, price: 0, time: '2026-08-04T13:32:04+0000' }] },
      ],
    }
    assert.equal(classifyFill(explicit).filled, false)
  })

  it('a REAL fill is unaffected — quantity present and non-zero', () => {
    const c = classifyFill(SPY_ROLL_CONDOR)
    assert.equal(c.filled, true)
    assert.equal(c.legs.find((l) => l.strike === 740)?.price, 5.05)
  })
})
