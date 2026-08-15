import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { checkBalance, summarizeBalance } from './balance'
import { diffPositions, positionsToQty } from './position-delta'
import { sumEffects } from './order-effects'
import { GOLDEN_FILLS } from './classify-fill.test'

const { SPY_SPLIT_CLOSE, SPY_SPLIT_OPEN } = GOLDEN_FILLS

const NOW = new Date('2026-08-14T21:00:00Z')

const opt = (symbol: string, long: number, short: number) => ({
  instrument: { assetType: 'OPTION', symbol },
  longQuantity: long,
  shortQuantity: short,
})

// The REAL SPY 2026-09-11 condor, before and after the Aug 14 split roll.
// Journal read 735/750/775/790 that morning and 750/765/775/790 after.
const BEFORE = [
  opt('SPY   260911P00735000', 1, 0),
  opt('SPY   260911P00750000', 0, 1),
  opt('SPY   260911C00775000', 0, 1),
  opt('SPY   260911C00790000', 1, 0),
]
const AFTER = [
  opt('SPY   260911P00750000', 1, 0),
  opt('SPY   260911P00765000', 0, 1),
  opt('SPY   260911C00775000', 0, 1),
  opt('SPY   260911C00790000', 1, 0),
]

describe('the accounting identity — real data, end to end (spec §2)', () => {
  it('the Aug 14 SPY split roll balances to EXACTLY ZERO', () => {
    // This is the whole thesis. Two VERTICAL tickets 4m28s apart say nothing
    // about being a roll — but positions(T₀) + Σ effects == positions(T₁)
    // holds regardless, which is what makes the interval PROVABLY complete
    // even where classification is unsure.
    const delta = diffPositions(positionsToQty(BEFORE), positionsToQty(AFTER))
    const effects = sumEffects([SPY_SPLIT_CLOSE, SPY_SPLIT_OPEN])

    // The observed change: old long gone, 750 flipped short→long, new short.
    assert.equal(delta.get('SPY   260911P00735000'), -1)
    assert.equal(delta.get('SPY   260911P00750000'), 2)
    assert.equal(delta.get('SPY   260911P00765000'), -1)
    assert.equal(delta.size, 3, 'the untouched call side must not appear')

    const result = checkBalance(delta, effects.symbols, effects.refusals, NOW)
    assert.equal(result.status, 'BALANCED')
    assert.equal(result.balanced, true)
    assert.equal(result.residual.size, 0)
    assert.deepEqual(result.findings, [])
  })

  it('dropping ONE half of the split roll leaves an exact, named residual', () => {
    const delta = diffPositions(positionsToQty(BEFORE), positionsToQty(AFTER))
    const partial = sumEffects([SPY_SPLIT_CLOSE]) // the open ticket is missing

    const result = checkBalance(delta, partial.symbols, partial.refusals, NOW)
    assert.equal(result.status, 'RESIDUAL')
    assert.equal(result.balanced, false)
    // Exactly the legs the missing ticket would have moved.
    assert.equal(result.residual.get('SPY   260911P00765000'), -1)
    assert.equal(result.residual.get('SPY   260911P00750000'), 1)
    assert.ok(result.findings.every((f) => f.kind === 'UNEXPLAINED'))
  })
})

describe('checkBalance — residual classification', () => {
  it('a vanished position whose contract already expired is EXPIRED', () => {
    // Expiries produce NO Schwab order, so this is the only trace one leaves.
    const delta = new Map([['SPY   260807P00700000', -1]])
    const r = checkBalance(delta, new Map(), [], NOW)
    assert.equal(r.status, 'RESIDUAL')
    assert.equal(r.findings[0].kind, 'EXPIRED')
    assert.match(r.findings[0].detail, /expired on 2026-08-07/)
  })

  it('a vanished position that has NOT expired is UNEXPLAINED', () => {
    const delta = new Map([['SPY   260911P00700000', -1]])
    const r = checkBalance(delta, new Map(), [], NOW)
    assert.equal(r.findings[0].kind, 'UNEXPLAINED')
    assert.match(r.findings[0].detail, /assignment or exercise/)
  })

  it('expiring TODAY is not yet EXPIRED — the boundary is start-of-day UTC', () => {
    const delta = new Map([['SPY   260814P00700000', -1]])
    assert.equal(checkBalance(delta, new Map(), [], NOW).findings[0].kind, 'UNEXPLAINED')
  })

  it('an unparseable symbol is UNEXPLAINED, never assumed to be an expiry', () => {
    const r = checkBalance(new Map([['WEIRD~SYMBOL', -1]]), new Map(), [], NOW)
    assert.equal(r.findings[0].kind, 'UNEXPLAINED')
    assert.match(r.findings[0].detail, /could not be parsed/)
  })

  it('findings are sorted by symbol so output is deterministic', () => {
    const delta = new Map([
      ['SPY   260911P00765000', -1],
      ['GLD   260918P00395000', -2],
    ])
    const r = checkBalance(delta, new Map(), [], NOW)
    assert.deepEqual(r.findings.map((f) => f.occSymbol), [
      'GLD   260918P00395000',
      'SPY   260911P00765000',
    ])
  })
})

describe('checkBalance — UNRELIABLE dominates', () => {
  it('a refusal makes the interval UNRELIABLE even when the residual is zero', () => {
    // The residual is not evidence about the ACCOUNT when our own arithmetic
    // is incomplete — reporting BALANCED here would manufacture a false proof.
    const r = checkBalance(new Map(), new Map(), ['order 5: leg 99 has no matching order leg'], NOW)
    assert.equal(r.status, 'UNRELIABLE')
    assert.equal(r.balanced, false)
    assert.equal(r.residual.size, 0)
  })

  it('a refusal outranks a residual', () => {
    const r = checkBalance(new Map([['SPY   260911P00700000', -1]]), new Map(), ['bad'], NOW)
    assert.equal(r.status, 'UNRELIABLE')
  })

  it('balanced is TRUE only for a zero residual with no refusals', () => {
    assert.equal(checkBalance(new Map(), new Map(), [], NOW).balanced, true)
  })

  it('an EXPIRED-only residual is still not balanced — the exit needs journaling', () => {
    // The auto-write gate is "zero residual", not "nothing worrying". An
    // expiry is explained as a CAUSE but still leaves the journal stale.
    const r = checkBalance(new Map([['SPY   260807P00700000', -1]]), new Map(), [], NOW)
    assert.equal(r.balanced, false)
  })
})

describe('summarizeBalance', () => {
  it('never renders an unbalanced interval as clean', () => {
    const r = checkBalance(new Map([['SPY   260911P00700000', -1]]), new Map(), [], NOW)
    assert.match(summarizeBalance(r), /RESIDUAL — 1 UNEXPLAINED/)
  })

  it('says UNRELIABLE proves nothing, rather than reporting a count', () => {
    const r = checkBalance(new Map(), new Map(), ['x'], NOW)
    assert.match(summarizeBalance(r), /proves nothing/)
  })

  it('states the completeness claim explicitly when balanced', () => {
    assert.match(
      summarizeBalance(checkBalance(new Map(), new Map(), [], NOW)),
      /every position change is explained/,
    )
  })

  it('counts expired and unexplained separately', () => {
    const delta = new Map([
      ['SPY   260807P00700000', -1], // expired
      ['SPY   260911P00700000', -1], // not
    ])
    assert.match(summarizeBalance(checkBalance(delta, new Map(), [], NOW)), /1 UNEXPLAINED, 1 expired/)
  })
})
