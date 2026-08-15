import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  heldContractsByKey,
  heldContractsFor,
  heldContractsFromPositions,
  heldKey,
} from './held-contracts'

const opt = (symbol: string, long: number, short: number) => ({
  instrument: { assetType: 'OPTION', symbol },
  longQuantity: long,
  shortQuantity: short,
})

/** The GLD 2026-09-18 condor as held on 2026-08-14: TWO lots, one Schwab row each. */
const GLD_TWO_LOT = [
  opt('GLD   260918P00375000', 2, 0),
  opt('GLD   260918P00395000', 0, 2),
  opt('GLD   260918C00400000', 0, 2),
  opt('GLD   260918C00420000', 2, 0),
]

/** A single 1-lot SPY condor. */
const SPY_ONE_LOT = [
  opt('SPY   260911P00750000', 1, 0),
  opt('SPY   260911P00765000', 0, 1),
  opt('SPY   260911C00775000', 0, 1),
  opt('SPY   260911C00790000', 1, 0),
]

describe('heldContractsFromPositions — the case v2.12 exists to fix', () => {
  it('reports 2 for the AGGREGATED GLD pair', () => {
    // Two 1-lot condors at identical strikes arrive as one row at qty 2. Without
    // this number the guard blocks trade B's GTC forever.
    const held = heldContractsFromPositions(GLD_TWO_LOT)
    assert.equal(heldContractsFor(held, 'GLD', '2026-09-18'), 2)
  })

  it('reports 1 for a single 1-lot condor', () => {
    const held = heldContractsFromPositions(SPY_ONE_LOT)
    assert.equal(heldContractsFor(held, 'SPY', '2026-09-11'), 1)
  })

  it('keys each underlying+expiration separately', () => {
    const held = heldContractsFromPositions([...GLD_TWO_LOT, ...SPY_ONE_LOT])
    assert.equal(heldContractsFor(held, 'GLD', '2026-09-18'), 2)
    assert.equal(heldContractsFor(held, 'SPY', '2026-09-11'), 1)
    assert.equal(held.size, 2)
  })
})

describe('heldContractsFromPositions — fail-safe returns null, never a guess', () => {
  it('MIXED magnitudes yield null — a partial close or stacked unequal sizes', () => {
    const partial = [
      opt('SPY   260911P00750000', 1, 0),
      opt('SPY   260911P00765000', 0, 1),
      opt('SPY   260911C00775000', 0, 2), // one leg is bigger
      opt('SPY   260911C00790000', 1, 0),
    ]
    const held = heldContractsFromPositions(partial)
    assert.equal(heldContractsFor(held, 'SPY', '2026-09-11'), null)
    assert.ok(held.has(heldKey('SPY', '2026-09-11')), 'present, explicitly unknown')
  })

  it('an ABSENT key is null — the guard cannot tell "not held" from "unknown"', () => {
    // Both mean the same thing to the guard: no evidence a placement is safe.
    const held = heldContractsFromPositions(SPY_ONE_LOT)
    assert.equal(heldContractsFor(held, 'GLD', '2026-09-18'), null)
  })

  it('an empty account yields an empty map, not a throw', () => {
    assert.equal(heldContractsFromPositions([]).size, 0)
  })

  it('ignores equity — it cannot participate in an option contract count', () => {
    const held = heldContractsFromPositions([
      ...SPY_ONE_LOT,
      { instrument: { assetType: 'EQUITY', symbol: 'SPY' }, longQuantity: 100, shortQuantity: 0 },
    ])
    assert.equal(heldContractsFor(held, 'SPY', '2026-09-11'), 1)
  })
})

describe('heldContractsFromPositions — conservative where it cannot be precise', () => {
  it('eight legs at one lot report 1, not 2 — under-placing is the safe direction', () => {
    // Two DIFFERENT-strike condors on one key. Arguably "2 condors", but
    // reporting 1 makes the guard stop after the first GTC, i.e. fall back to
    // today's behaviour. Over-covering is the hazard; under-placing is not.
    const twoDistinct = [
      opt('SPY   260911P00700000', 1, 0),
      opt('SPY   260911P00715000', 0, 1),
      opt('SPY   260911C00775000', 0, 1),
      opt('SPY   260911C00790000', 1, 0),
      opt('SPY   260911P00750000', 1, 0),
      opt('SPY   260911P00765000', 0, 1),
      opt('SPY   260911C00800000', 0, 1),
      opt('SPY   260911C00825000', 1, 0),
    ]
    assert.equal(heldContractsFor(heldContractsFromPositions(twoDistinct), 'SPY', '2026-09-11'), 1)
  })

  it('a net-zero leg is omitted rather than counted as magnitude 0', () => {
    // positionsToQty drops net-zero rows; a stray 0 would otherwise make the
    // magnitude set {0,1} and turn a knowable key into null.
    const withFlat = [...SPY_ONE_LOT, opt('SPY   260911P00700000', 1, 1)]
    assert.equal(heldContractsFor(heldContractsFromPositions(withFlat), 'SPY', '2026-09-11'), 1)
  })
})

describe('heldContractsByKey — operates on the v2.11 symbol map', () => {
  it('accepts a SymbolQty directly, so the cron can reuse one derivation', () => {
    const symbols = new Map([
      ['GLD   260918P00375000', 2],
      ['GLD   260918P00395000', -2],
    ])
    assert.equal(heldContractsFor(heldContractsByKey(symbols), 'GLD', '2026-09-18'), 2)
  })

  it('an unparseable symbol contributes nothing rather than corrupting a key', () => {
    const symbols = new Map([
      ['SPY   260911P00750000', 1],
      ['WEIRD~SYMBOL', 5],
    ])
    assert.equal(heldContractsFor(heldContractsByKey(symbols), 'SPY', '2026-09-11'), 1)
  })
})
