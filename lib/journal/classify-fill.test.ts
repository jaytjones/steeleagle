// ============================================================
// SteelEagle — v2.11 classify-fill golden fixtures
//
// Seven REAL Schwab payloads pulled 2026-08-14 via
// `scripts/dump-filled-orders.ts`, trimmed to the fields the classifier reads
// and with `accountNumber` stripped (F4 — it is present on every raw order
// body, six occurrences in a 14-day window).
//
// These are the doctrine artefacts for v2.11. If a test here fails after a
// refactor, the refactor is wrong — these are Schwab's own records of April's
// actual trades, not our idea of what they should look like.
// ============================================================

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { classifyFill, fillLegRole, isLifecycleShape } from './classify-fill'
import type { SchwabOrderDetail } from '../schwab/orders'

// --------------------------------------------------------
// Fixtures — verbatim from the live account
// --------------------------------------------------------

/** 4-leg entry. GLD 2026-09-18 330/350/400/420, NET_CREDIT 4.14. */
const GLD_ENTRY: SchwabOrderDetail = {
  orderId: 1007457102802,
  status: 'FILLED',
  enteredTime: '2026-08-04T15:14:55+0000',
  closeTime: '2026-08-04T15:40:43+0000',
  orderType: 'NET_CREDIT',
  complexOrderStrategyType: 'IRON_CONDOR',
  quantity: 1,
  filledQuantity: 1,
  price: 4.14,
  orderLegCollection: [
    { legId: 1, instruction: 'SELL_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'GLD   260918C00400000', putCall: 'CALL' } },
    { legId: 2, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'GLD   260918C00420000', putCall: 'CALL' } },
    { legId: 3, instruction: 'SELL_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'GLD   260918P00350000', putCall: 'PUT' } },
    { legId: 4, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'GLD   260918P00330000', putCall: 'PUT' } },
  ],
  orderActivityCollection: [
    {
      executionLegs: [
        { legId: 1, quantity: 1, price: 3.72, time: '2026-08-04T15:40:43+0000' },
        { legId: 2, quantity: 1, price: 1.41, time: '2026-08-04T15:40:43+0000' },
        { legId: 3, quantity: 1, price: 2.75, time: '2026-08-04T15:40:43+0000' },
        { legId: 4, quantity: 1, price: 0.92, time: '2026-08-04T15:40:43+0000' },
      ],
    },
  ],
}

/** 4-leg close of the v2.7 BUTTERFLY. SPY 2026-08-28 745/765/765/785, NET_DEBIT 14. */
const SPY_BUTTERFLY_CLOSE: SchwabOrderDetail = {
  orderId: 1007514529392,
  status: 'FILLED',
  enteredTime: '2026-08-07T16:09:02+0000',
  closeTime: '2026-08-07T16:25:32+0000',
  orderType: 'NET_DEBIT',
  complexOrderStrategyType: 'IRON_CONDOR',
  quantity: 1,
  filledQuantity: 1,
  price: 14,
  orderLegCollection: [
    { legId: 1, instruction: 'BUY_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260828C00765000', putCall: 'CALL' } },
    { legId: 2, instruction: 'SELL_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260828C00785000', putCall: 'CALL' } },
    { legId: 3, instruction: 'BUY_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260828P00765000', putCall: 'PUT' } },
    { legId: 4, instruction: 'SELL_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260828P00745000', putCall: 'PUT' } },
  ],
  orderActivityCollection: [
    {
      executionLegs: [
        { legId: 1, quantity: 1, price: 14.38, time: '2026-08-07T16:25:32+0000' },
        { legId: 2, quantity: 1, price: 4.03, time: '2026-08-07T16:25:32+0000' },
        { legId: 3, quantity: 1, price: 5.83, time: '2026-08-07T16:25:32+0000' },
        { legId: 4, quantity: 1, price: 2.18, time: '2026-08-07T16:25:32+0000' },
      ],
    },
  ],
}

/** Single-ticket roll, labelled CONDOR. SPY 2026-09-11 put side 700/715 → 725/740. */
const SPY_ROLL_CONDOR: SchwabOrderDetail = {
  orderId: 1007454721397,
  status: 'FILLED',
  enteredTime: '2026-08-04T14:39:22+0000',
  closeTime: '2026-08-04T14:39:22+0000',
  orderType: 'NET_CREDIT',
  complexOrderStrategyType: 'CONDOR',
  quantity: 1,
  filledQuantity: 1,
  price: 1.05,
  orderLegCollection: [
    { legId: 1, instruction: 'SELL_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00740000', putCall: 'PUT' } },
    { legId: 2, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00725000', putCall: 'PUT' } },
    { legId: 3, instruction: 'BUY_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00715000', putCall: 'PUT' } },
    { legId: 4, instruction: 'SELL_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00700000', putCall: 'PUT' } },
  ],
  orderActivityCollection: [
    {
      executionLegs: [
        { legId: 1, quantity: 1, price: 5.05, time: '2026-08-04T14:39:22+0000' },
        { legId: 2, quantity: 1, price: 3.25, time: '2026-08-04T14:39:22+0000' },
        { legId: 3, quantity: 1, price: 2.49, time: '2026-08-04T14:39:22+0000' },
        { legId: 4, quantity: 1, price: 1.74, time: '2026-08-04T14:39:22+0000' },
      ],
    },
  ],
}

/**
 * THE F2 FIXTURE. Structurally identical to SPY_ROLL_CONDOR — a four-leg
 * SPY 2026-09-11 put roll — but Schwab labelled it `CUSTOM`, not `CONDOR`.
 * This pair is the entire argument for never reading the strategy type.
 */
const SPY_ROLL_CUSTOM: SchwabOrderDetail = {
  orderId: 1007483420023,
  status: 'FILLED',
  enteredTime: '2026-08-05T17:55:58+0000',
  closeTime: '2026-08-05T17:56:00+0000',
  orderType: 'NET_CREDIT',
  complexOrderStrategyType: 'CUSTOM',
  quantity: 1,
  filledQuantity: 1,
  price: 0.62,
  orderLegCollection: [
    { legId: 1, instruction: 'SELL_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00750000', putCall: 'PUT' } },
    { legId: 2, instruction: 'BUY_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00740000', putCall: 'PUT' } },
    { legId: 3, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00735000', putCall: 'PUT' } },
    { legId: 4, instruction: 'SELL_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00725000', putCall: 'PUT' } },
  ],
  orderActivityCollection: [
    {
      executionLegs: [
        { legId: 1, quantity: 1, price: 5.77, time: '2026-08-05T17:56:00+0000' },
        { legId: 2, quantity: 1, price: 4.26, time: '2026-08-05T17:56:00+0000' },
        { legId: 3, quantity: 1, price: 3.69, time: '2026-08-05T17:56:00+0000' },
        { legId: 4, quantity: 1, price: 2.8, time: '2026-08-05T17:56:00+0000' },
      ],
    },
  ],
}

/** 2-LOT single-ticket roll. GLD 2026-09-18 put side 365/385 → 375/395. */
const GLD_ROLL_TWO_LOT: SchwabOrderDetail = {
  orderId: 1007598809028,
  status: 'FILLED',
  enteredTime: '2026-08-14T16:04:14+0000',
  closeTime: '2026-08-14T16:04:15+0000',
  orderType: 'NET_CREDIT',
  complexOrderStrategyType: 'CONDOR',
  quantity: 2,
  filledQuantity: 2,
  price: 2.02,
  orderLegCollection: [
    { legId: 1, instruction: 'SELL_TO_OPEN', quantity: 2, instrument: { assetType: 'OPTION', symbol: 'GLD   260918P00395000', putCall: 'PUT' } },
    { legId: 2, instruction: 'BUY_TO_CLOSE', quantity: 2, instrument: { assetType: 'OPTION', symbol: 'GLD   260918P00385000', putCall: 'PUT' } },
    { legId: 3, instruction: 'BUY_TO_OPEN', quantity: 2, instrument: { assetType: 'OPTION', symbol: 'GLD   260918P00375000', putCall: 'PUT' } },
    { legId: 4, instruction: 'SELL_TO_CLOSE', quantity: 2, instrument: { assetType: 'OPTION', symbol: 'GLD   260918P00365000', putCall: 'PUT' } },
  ],
  orderActivityCollection: [
    {
      executionLegs: [
        { legId: 1, quantity: 2, price: 6.83, time: '2026-08-14T16:04:15+0000' },
        { legId: 2, quantity: 2, price: 3.88, time: '2026-08-14T16:04:15+0000' },
        { legId: 3, quantity: 2, price: 2.1, time: '2026-08-14T16:04:15+0000' },
        { legId: 4, quantity: 2, price: 1.17, time: '2026-08-14T16:04:15+0000' },
      ],
    },
  ],
}

/** SPLIT ROLL, leg 1 of 2 — the close. SPY 2026-09-11, 15:59:25Z. */
const SPY_SPLIT_CLOSE: SchwabOrderDetail = {
  orderId: 1007598808689,
  status: 'FILLED',
  enteredTime: '2026-08-14T15:59:25+0000',
  closeTime: '2026-08-14T15:59:26+0000',
  orderType: 'NET_DEBIT',
  complexOrderStrategyType: 'VERTICAL',
  quantity: 1,
  filledQuantity: 1,
  price: 1.25,
  orderLegCollection: [
    { legId: 1, instruction: 'BUY_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00750000', putCall: 'PUT' } },
    { legId: 2, instruction: 'SELL_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00735000', putCall: 'PUT' } },
  ],
  orderActivityCollection: [
    {
      executionLegs: [
        { legId: 1, quantity: 1, price: 3.14, time: '2026-08-14T15:59:26+0000' },
        { legId: 2, quantity: 1, price: 1.89, time: '2026-08-14T15:59:26+0000' },
      ],
    },
  ],
}

/** SPLIT ROLL, leg 2 of 2 — the open. SPY 2026-09-11, 16:03:53Z (4m28s later). */
const SPY_SPLIT_OPEN: SchwabOrderDetail = {
  orderId: 1007598809002,
  status: 'FILLED',
  enteredTime: '2026-08-14T16:03:53+0000',
  closeTime: '2026-08-14T16:03:54+0000',
  orderType: 'NET_CREDIT',
  complexOrderStrategyType: 'VERTICAL',
  quantity: 1,
  filledQuantity: 1,
  price: 2.48,
  orderLegCollection: [
    { legId: 1, instruction: 'SELL_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00765000', putCall: 'PUT' } },
    { legId: 2, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00750000', putCall: 'PUT' } },
  ],
  orderActivityCollection: [
    {
      executionLegs: [
        { legId: 1, quantity: 1, price: 5.6, time: '2026-08-14T16:03:54+0000' },
        { legId: 2, quantity: 1, price: 3.12, time: '2026-08-14T16:03:54+0000' },
      ],
    },
  ],
}

export const GOLDEN_FILLS = {
  GLD_ENTRY,
  SPY_BUTTERFLY_CLOSE,
  SPY_ROLL_CONDOR,
  SPY_ROLL_CUSTOM,
  GLD_ROLL_TWO_LOT,
  SPY_SPLIT_CLOSE,
  SPY_SPLIT_OPEN,
}

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
