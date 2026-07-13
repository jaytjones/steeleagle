/**
 * Run with:  npx tsx --test lib/schwab/order-ticket.test.ts
 *
 * Golden-fixture tests for the v2.0 order-ticket builder.
 *
 * THE GOLDEN FIXTURE IS REAL: on July 12, 2026 an unfillable SPY iron condor
 * (SC 850 / LC 860 / SP 650 / LP 640, NET_CREDIT $8.00, DAY) was placed in
 * thinkorswim and read back verbatim via GET /accounts/{hash}/orders
 * (scripts/dump-working-orders.ts). GOLDEN below is that record with the
 * read-only echo fields stripped. If these tests ever need "fixing" to pass,
 * the payload shape has drifted — re-derive from a live order, don't guess.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildCondorOrder, buildOccSymbol, formatOrderPrice } from './order-ticket'
import { parseOccSymbol } from '@/lib/strategy/reconstruct-positions'
import type { CondorSetup, CondorLeg } from '@/types'

// --------------------------------------------------------
// Fixture helpers
// --------------------------------------------------------
function legFix(over: Partial<CondorLeg>): CondorLeg {
  return { type: 'call', action: 'buy', strike: 0, delta: 0, bid: 0, ask: 0, mark: 0, ...over }
}

/** Minimal CondorSetup carrying only what the builder reads. */
function setupFix(over: Partial<CondorSetup> = {}): CondorSetup {
  return {
    symbol: 'SPY',
    expiration: '2026-08-21',
    dte: 40,
    underlyingPrice: 700,
    ivRank: { symbol: 'SPY', currentIv: 20, ivRank: 40, daysOfHistory: 200 },
    longPut: legFix({ type: 'put', action: 'buy', strike: 640, delta: -0.05 }),
    shortPut: legFix({ type: 'put', action: 'sell', strike: 650, delta: -0.16 }),
    shortCall: legFix({ type: 'call', action: 'sell', strike: 850, delta: 0.16 }),
    longCall: legFix({ type: 'call', action: 'buy', strike: 860, delta: 0.05 }),
    totalCredit: 1.8,
    commissionRoundTrip: 5.2,
    netCreditAfterCommission: 174.8,
    wingWidth: 10,
    creditToWidthRatio: 0.18,
    maxLoss: 8.2,
    ...over,
  } as CondorSetup
}

// --------------------------------------------------------
// THE GOLDEN FIXTURE — Schwab's own record, echo fields stripped.
// --------------------------------------------------------
const GOLDEN = {
  orderStrategyType: 'SINGLE',
  complexOrderStrategyType: 'IRON_CONDOR',
  orderType: 'NET_CREDIT',
  price: '8.00',
  duration: 'DAY',
  session: 'NORMAL',
  quantity: 1,
  orderLegCollection: [
    {
      instruction: 'SELL_TO_OPEN',
      quantity: 1,
      instrument: { assetType: 'OPTION', symbol: 'SPY   260821C00850000' },
    },
    {
      instruction: 'BUY_TO_OPEN',
      quantity: 1,
      instrument: { assetType: 'OPTION', symbol: 'SPY   260821C00860000' },
    },
    {
      instruction: 'SELL_TO_OPEN',
      quantity: 1,
      instrument: { assetType: 'OPTION', symbol: 'SPY   260821P00650000' },
    },
    {
      instruction: 'BUY_TO_OPEN',
      quantity: 1,
      instrument: { assetType: 'OPTION', symbol: 'SPY   260821P00640000' },
    },
  ],
}

// --------------------------------------------------------
// buildCondorOrder — golden fixture
// --------------------------------------------------------
describe('buildCondorOrder — golden fixture (live Schwab record, 2026-07-12)', () => {
  it('reproduces the canonical payload exactly', () => {
    const ticket = buildCondorOrder(setupFix(), { quantity: 1, price: 8 })
    assert.deepEqual(ticket, GOLDEN)
  })

  it('serializes with no extra or missing keys vs. the canonical record', () => {
    const ticket = buildCondorOrder(setupFix(), { quantity: 1, price: 8 })
    assert.equal(JSON.stringify(ticket), JSON.stringify(GOLDEN))
  })

  it('leg order is SC, LC, SP, LP (as TOS emitted)', () => {
    const ticket = buildCondorOrder(setupFix(), { quantity: 1, price: 8 })
    const kinds = ticket.orderLegCollection.map(
      (l) => `${l.instruction}:${l.instrument.symbol.charAt(12)}`, // 13th char = C|P
    )
    assert.deepEqual(kinds, ['SELL_TO_OPEN:C', 'BUY_TO_OPEN:C', 'SELL_TO_OPEN:P', 'BUY_TO_OPEN:P'])
  })

  it('defaults price to the setup mid-credit when not overridden', () => {
    const ticket = buildCondorOrder(setupFix({ totalCredit: 1.8 }), { quantity: 1 })
    assert.equal(ticket.price, '1.80')
  })

  it('multi-contract quantity lands on the order AND every leg', () => {
    const ticket = buildCondorOrder(setupFix(), { quantity: 2, price: 1.8 })
    assert.equal(ticket.quantity, 2)
    for (const l of ticket.orderLegCollection) assert.equal(l.quantity, 2)
  })
})

// --------------------------------------------------------
// buildCondorOrder — guardrails (Schwab does NO server-side review;
// throwing here is the safety layer)
// --------------------------------------------------------
describe('buildCondorOrder — guardrails', () => {
  it('rejects strike order violations (SP ≥ SC)', () => {
    const bad = setupFix({
      shortPut: legFix({ type: 'put', action: 'sell', strike: 860 }),
    })
    assert.throws(() => buildCondorOrder(bad, { quantity: 1, price: 1.8 }), /LP < SP < SC < LC/)
  })

  it('rejects inverted wings (LP ≥ SP)', () => {
    const bad = setupFix({
      longPut: legFix({ type: 'put', action: 'buy', strike: 655 }),
    })
    assert.throws(() => buildCondorOrder(bad, { quantity: 1, price: 1.8 }), /LP < SP < SC < LC/)
  })

  it('rejects credit ≥ narrower wing width (impossible fill)', () => {
    assert.throws(
      () => buildCondorOrder(setupFix(), { quantity: 1, price: 10 }),
      /impossible fill/,
    )
    // 8.00 on the $10 golden wings is fine (that IS the unfillable-test trick)
    assert.doesNotThrow(() => buildCondorOrder(setupFix(), { quantity: 1, price: 9.99 }))
  })

  it('rejects zero / negative / non-integer quantity', () => {
    assert.throws(() => buildCondorOrder(setupFix(), { quantity: 0, price: 1.8 }), /positive integer/)
    assert.throws(() => buildCondorOrder(setupFix(), { quantity: -1, price: 1.8 }), /positive integer/)
    assert.throws(() => buildCondorOrder(setupFix(), { quantity: 1.5, price: 1.8 }), /positive integer/)
  })

  it('rejects zero / negative credit', () => {
    assert.throws(() => buildCondorOrder(setupFix(), { quantity: 1, price: 0 }), /positive/)
    assert.throws(() => buildCondorOrder(setupFix(), { quantity: 1, price: -1.8 }), /positive/)
  })

  it('rejects a non-ISO expiration', () => {
    const bad = setupFix({ expiration: '08/21/2026' })
    assert.throws(() => buildCondorOrder(bad, { quantity: 1, price: 1.8 }), /YYYY-MM-DD/)
  })
})

// --------------------------------------------------------
// buildOccSymbol — exact inverse of parseOccSymbol
// --------------------------------------------------------
describe('buildOccSymbol', () => {
  it('matches all four canonical leg symbols byte-for-byte', () => {
    assert.equal(buildOccSymbol('SPY', '2026-08-21', 'CALL', 850), 'SPY   260821C00850000')
    assert.equal(buildOccSymbol('SPY', '2026-08-21', 'CALL', 860), 'SPY   260821C00860000')
    assert.equal(buildOccSymbol('SPY', '2026-08-21', 'PUT', 650), 'SPY   260821P00650000')
    assert.equal(buildOccSymbol('SPY', '2026-08-21', 'PUT', 640), 'SPY   260821P00640000')
  })

  it('is always 21 characters, for 1–4 char roots', () => {
    for (const root of ['V', 'KO', 'SPY', 'UVXY']) {
      assert.equal(buildOccSymbol(root, '2026-08-21', 'CALL', 100).length, 21)
    }
  })

  it('round-trips through parseOccSymbol for every strategy-universe shape', () => {
    const cases: Array<[string, string, 'PUT' | 'CALL', number]> = [
      ['SPY', '2026-08-21', 'CALL', 850],
      ['UVXY', '2026-09-18', 'PUT', 22.5], // fractional strike
      ['GLD', '2026-12-18', 'CALL', 305],
      ['FXB', '2027-01-15', 'PUT', 120],
    ]
    for (const [u, exp, pc, strike] of cases) {
      const parsed = parseOccSymbol(buildOccSymbol(u, exp, pc, strike))
      assert.ok(parsed, `parseOccSymbol failed on ${u}`)
      assert.equal(parsed!.underlying, u)
      assert.equal(parsed!.expiration, exp)
      assert.equal(parsed!.putCall, pc)
      assert.equal(parsed!.strike, strike)
    }
  })

  it('encodes fractional strikes to the milli field (22.5 → 00022500)', () => {
    assert.equal(buildOccSymbol('UVXY', '2026-09-18', 'PUT', 22.5), 'UVXY  260918P00022500')
  })

  it('rejects sub-$0.001 strike precision instead of silently rounding', () => {
    assert.throws(() => buildOccSymbol('SPY', '2026-08-21', 'CALL', 850.0004), /precision/)
  })

  it('rejects bad inputs', () => {
    assert.throws(() => buildOccSymbol('', '2026-08-21', 'CALL', 100))
    assert.throws(() => buildOccSymbol('TOOLONG7', '2026-08-21', 'CALL', 100))
    assert.throws(() => buildOccSymbol('SPY', '260821', 'CALL', 100), /YYYY-MM-DD/)
    assert.throws(() => buildOccSymbol('SPY', '2026-08-21', 'CALL', 0))
  })
})

// --------------------------------------------------------
// formatOrderPrice — Schwab's truncation rules
// --------------------------------------------------------
describe('formatOrderPrice', () => {
  it('≥ $1 → 2 dp', () => {
    assert.equal(formatOrderPrice(8), '8.00')
    assert.equal(formatOrderPrice(1.8), '1.80')
    assert.equal(formatOrderPrice(1), '1.00')
  })

  it('< $1 → 4 dp', () => {
    assert.equal(formatOrderPrice(0.85), '0.8500')
    assert.equal(formatOrderPrice(0.1234), '0.1234')
  })

  it('truncates, never rounds up', () => {
    assert.equal(formatOrderPrice(1.859), '1.85')
    assert.equal(formatOrderPrice(0.12349), '0.1234')
  })

  it('survives float artifacts on clean values', () => {
    assert.equal(formatOrderPrice(0.1 + 0.2), '0.3000') // 0.30000000000000004
    assert.equal(formatOrderPrice(1.1 + 0.7), '1.80')
  })

  it('rejects zero / negative / non-finite', () => {
    assert.throws(() => formatOrderPrice(0))
    assert.throws(() => formatOrderPrice(-1.8))
    assert.throws(() => formatOrderPrice(Number.NaN))
  })
})
