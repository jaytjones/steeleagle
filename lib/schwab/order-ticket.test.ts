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

  // v2.7.1 — the deliberate ASYMMETRY between the two builders. The exit path
  // accepts butterflies (fixture 1007469542479 pinned 2026-08-04); the ENTRY
  // path must not, on two independent grounds:
  //   1. That fixture is a CLOSE. The entry payload (NET_CREDIT / *_TO_OPEN)
  //      for a butterfly has never been recorded — the doctrine still binds.
  //   2. April, 2026-08-04: butterflies arise from ROLLS only; the app must
  //      never open one. buildCondor cannot even produce one (16Δ vs ~50Δ
  //      shorts), so this fires only on a hand-edited PlaceOrderPanel submit.
  // If this test ever starts failing, the entry gate has been opened by
  // accident — do not "fix" it by loosening the assertion.
  it('still REFUSES an iron butterfly (SP == SC) — entry is not fixture-pinned', () => {
    const fly = setupFix({
      shortPut: legFix({ type: 'put', action: 'sell', strike: 850 }), // == the 850 short call
    })
    assert.throws(
      () => buildCondorOrder(fly, { quantity: 1, price: 1.8 }),
      /iron BUTTERFLY/,
    )
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

// --------------------------------------------------------
// v2.4 — the Schwab doctrine gate + explicit OCC root
//
// Schwab performs no server-side review: a payload built from a guessed symbol
// format submits and can execute. Until a real index order has been placed,
// cancelled and pinned, the builder refuses rather than guessing (spec §8.1/V7).
// --------------------------------------------------------
describe('order-fixture gate (v2.4)', () => {
  const strikes = {
    longPut: { strike: 700 },
    shortPut: { strike: 720 },
    shortCall: { strike: 770 },
    longCall: { strike: 790 },
  }

  it('REFUSES to build a ticket for the still-unpinned indices', () => {
    for (const symbol of ['SPX', 'NDX', 'RUT']) {
      assert.throws(
        () => buildCondorOrder({ symbol, expiration: '2026-09-18', ...strikes }, { quantity: 1, price: 2 }),
        /no pinned order fixture/,
        symbol,
      )
    }
  })

  it('BUILDS for XSP — fixture pinned 2026-07-30', () => {
    const t = buildCondorOrder(
      { symbol: 'XSP', expiration: '2026-09-18', ...strikes },
      { quantity: 1, price: 2 },
    )
    assert.equal(t.orderLegCollection.length, 4)
    assert.ok(t.orderLegCollection.every((l) => l.instrument.symbol.startsWith('XSP   ')))
  })

  it('names the place-and-cancel step in the refusal', () => {
    assert.throws(
      () => buildCondorOrder({ symbol: 'SPX', expiration: '2026-09-18', ...strikes }, { quantity: 1, price: 2 }),
      /orderFixturePinned/,
    )
  })

  it('still builds for every ETF and for off-universe tickers', () => {
    for (const symbol of ['SPY', 'TLT', 'GLD', 'ARKK']) {
      const t = buildCondorOrder(
        { symbol, expiration: '2026-09-18', ...strikes },
        { quantity: 1, price: 2 },
      )
      assert.equal(t.orderLegCollection.length, 4, symbol)
      assert.ok(t.orderLegCollection[0].instrument.symbol.startsWith(symbol), symbol)
    }
  })
})

// --------------------------------------------------------
// v2.4 — THE XSP GOLDEN FIXTURE (live Schwab record, 2026-07-30)
//
// A deliberately unfillable XSP iron condor (LP 700 / SP 710 / SC 770 / LC 780,
// exp 2026-08-27, NET_CREDIT $9.00, DAY, qty 1) was placed in thinkorswim,
// read back verbatim via GET /accounts/{hash}/orders as order 1007409658003
// (status PENDING_ACTIVATION — placed after hours), and cancelled. This
// answered V7 (spec §8.1): the leg symbols are standard OCC, byte-identical in
// form to the SPY fixture ("XSP   260827P00700000" — 3-char root padded to 6),
// and the order envelope (SINGLE / IRON_CONDOR / NET_CREDIT / OPTION legs)
// matches the ETF entry shape exactly.
//
// Two readback notes, recorded so nobody "fixes" them later:
//  - LEG ORDER in the readback was LP, SP, SC, LC — different from the SPY
//    fixture's SC, LC, SP, LP. Both were accepted by Schwab, and the app's
//    POSTed SC/LC/SP/LP order is proven live by the shipped ETF path. Leg
//    order is a TOS emission artifact, not a contract; the builder keeps its
//    canonical order and this test asserts the leg SET + exact symbols.
//  - `price` echoed back as a NUMBER (9), not a string. The POST sends a
//    formatted string, which the shipped ETF path proves Schwab accepts.
// --------------------------------------------------------
describe('XSP golden fixture (live Schwab record, 2026-07-30, order 1007409658003)', () => {
  const LIVE_LEG_SYMBOLS = [
    'XSP   260827P00700000', // BUY_TO_OPEN  long put 700
    'XSP   260827P00710000', // SELL_TO_OPEN short put 710
    'XSP   260827C00770000', // SELL_TO_OPEN short call 770
    'XSP   260827C00780000', // BUY_TO_OPEN  long call 780
  ]

  const xspInput = {
    symbol: 'XSP',
    expiration: '2026-08-27',
    longPut: { strike: 700 },
    shortPut: { strike: 710 },
    shortCall: { strike: 770 },
    longCall: { strike: 780 },
  }

  it('buildOccSymbol reproduces every live leg symbol byte-for-byte', () => {
    assert.equal(buildOccSymbol('XSP', '2026-08-27', 'PUT', 700), LIVE_LEG_SYMBOLS[0])
    assert.equal(buildOccSymbol('XSP', '2026-08-27', 'PUT', 710), LIVE_LEG_SYMBOLS[1])
    assert.equal(buildOccSymbol('XSP', '2026-08-27', 'CALL', 770), LIVE_LEG_SYMBOLS[2])
    assert.equal(buildOccSymbol('XSP', '2026-08-27', 'CALL', 780), LIVE_LEG_SYMBOLS[3])
  })

  it('the built ticket carries exactly the live leg set with the live instructions', () => {
    const t = buildCondorOrder(xspInput, { quantity: 1, price: 9 })
    const bySymbol = new Map(t.orderLegCollection.map((l) => [l.instrument.symbol, l]))
    assert.deepEqual([...bySymbol.keys()].sort(), [...LIVE_LEG_SYMBOLS].sort())
    assert.equal(bySymbol.get(LIVE_LEG_SYMBOLS[0])!.instruction, 'BUY_TO_OPEN')
    assert.equal(bySymbol.get(LIVE_LEG_SYMBOLS[1])!.instruction, 'SELL_TO_OPEN')
    assert.equal(bySymbol.get(LIVE_LEG_SYMBOLS[2])!.instruction, 'SELL_TO_OPEN')
    assert.equal(bySymbol.get(LIVE_LEG_SYMBOLS[3])!.instruction, 'BUY_TO_OPEN')
    for (const l of t.orderLegCollection) {
      assert.equal(l.instrument.assetType, 'OPTION')
      assert.equal(l.quantity, 1)
    }
  })

  it('the envelope matches the live record', () => {
    const t = buildCondorOrder(xspInput, { quantity: 1, price: 9 })
    assert.equal(t.orderStrategyType, 'SINGLE')
    assert.equal(t.complexOrderStrategyType, 'IRON_CONDOR')
    assert.equal(t.orderType, 'NET_CREDIT')
    assert.equal(t.duration, 'DAY')
    assert.equal(t.session, 'NORMAL')
    assert.equal(t.quantity, 1)
    assert.equal(t.price, '9.00') // POST form; readback echoes numeric 9
  })
})

describe('buildOccSymbol takes an OCC ROOT, not an underlying (spec §8.2)', () => {
  it('builds an index symbol from a PM root', () => {
    assert.equal(buildOccSymbol('SPXW', '2026-09-18', 'PUT', 6500), 'SPXW  260918P06500000')
  })

  it('builds the XSP form — 3-char root, same padding as an ETF', () => {
    assert.equal(buildOccSymbol('XSP', '2026-09-18', 'CALL', 780), 'XSP   260918C00780000')
  })

  it('accepts a full 6-char root', () => {
    assert.equal(buildOccSymbol('ABCDEF', '2026-09-18', 'PUT', 10), 'ABCDEF260918P00010000')
  })

  it('rejects a root longer than the 6-char OCC field', () => {
    assert.throws(() => buildOccSymbol('TOOLONG', '2026-09-18', 'PUT', 10), /invalid OCC root/)
  })
})
