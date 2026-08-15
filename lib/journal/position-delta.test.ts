import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  addQty,
  diffPositions,
  formatQty,
  positionsToQty,
  qtyFromJson,
  qtyToJson,
  subtractQty,
  type SymbolQty,
} from './position-delta'

const pos = (symbol: string, long: number, short: number) => ({
  instrument: { assetType: 'OPTION', symbol },
  longQuantity: long,
  shortQuantity: short,
})

const m = (entries: [string, number][]): SymbolQty => new Map(entries)

describe('positionsToQty', () => {
  it('signs long positive and short negative', () => {
    const q = positionsToQty([
      pos('SPY   260911P00735000', 1, 0),
      pos('SPY   260911P00750000', 0, 1),
    ])
    assert.equal(q.get('SPY   260911P00735000'), 1)
    assert.equal(q.get('SPY   260911P00750000'), -1)
  })

  it('carries Schwab’s AGGREGATED quantity as one entry', () => {
    // Two 1-lot condors at identical strikes arrive as one row at qty 2. The
    // delta is what later distinguishes them (spec §2); this layer just records.
    const q = positionsToQty([pos('GLD   260918P00395000', 0, 2)])
    assert.equal(q.get('GLD   260918P00395000'), -2)
  })

  it('skips non-option rows — equity cannot join an option-leg identity', () => {
    const q = positionsToQty([
      { instrument: { assetType: 'EQUITY', symbol: 'SPY' }, longQuantity: 100, shortQuantity: 0 },
      pos('SPY   260911P00735000', 1, 0),
    ])
    assert.equal(q.size, 1)
  })

  it('OMITS a net-zero row so "absent" and "zero" are the same state', () => {
    // Without this, the same holding could compare unequal depending on whether
    // Schwab happened to return a flat row.
    const q = positionsToQty([pos('SPY   260911P00735000', 1, 1)])
    assert.equal(q.size, 0)
  })

  it('sums a duplicated symbol rather than last-wins', () => {
    const q = positionsToQty([
      pos('SPY   260911P00735000', 1, 0),
      pos('SPY   260911P00735000', 2, 0),
    ])
    assert.equal(q.get('SPY   260911P00735000'), 3)
  })

  it('never parses the OCC symbol — an unparseable one still diffs', () => {
    // Keying on the raw string means a symbol this codebase cannot parse
    // appears on both sides of a diff and cancels, instead of vanishing.
    const q = positionsToQty([
      { instrument: { assetType: 'OPTION', symbol: 'WEIRD~SYMBOL' }, longQuantity: 1, shortQuantity: 0 },
    ])
    assert.equal(q.get('WEIRD~SYMBOL'), 1)
  })

  it('tolerates missing quantity fields', () => {
    const q = positionsToQty([{ instrument: { assetType: 'OPTION', symbol: 'X   260911P00001000' } }])
    assert.equal(q.size, 0)
  })
})

describe('diffPositions', () => {
  it('omits unchanged symbols so an empty result means "structurally identical"', () => {
    const before = m([['A', 1], ['B', -1]])
    const after = m([['A', 1], ['B', -1]])
    assert.equal(diffPositions(before, after).size, 0)
  })

  it('reports an opened position as a positive/negative appearance', () => {
    const d = diffPositions(m([]), m([['SPY   260911P00765000', -1]]))
    assert.equal(d.get('SPY   260911P00765000'), -1)
  })

  it('reports a closed position as the mirror change', () => {
    const d = diffPositions(m([['SPY   260911P00735000', 1]]), m([]))
    assert.equal(d.get('SPY   260911P00735000'), -1)
  })

  it('detects a SCALE-IN that a snapshot alone cannot attribute (spec §2)', () => {
    // GLD went 1 → 2 contracts at identical strikes. reconcile.ts documents
    // that state as indistinguishable from a single 2-lot; the DELTA is not.
    const d = diffPositions(m([['GLD   260918P00350000', -1]]), m([['GLD   260918P00350000', -2]]))
    assert.equal(d.get('GLD   260918P00350000'), -1)
  })

  it('handles a leg that flips from short to long in one interval', () => {
    // The real split roll did exactly this to SPY 750P: short 1 → long 1.
    const d = diffPositions(m([['SPY   260911P00750000', -1]]), m([['SPY   260911P00750000', 1]]))
    assert.equal(d.get('SPY   260911P00750000'), 2)
  })
})

describe('addQty / subtractQty', () => {
  it('drops entries that cancel to zero', () => {
    assert.equal(addQty(m([['A', 1]]), m([['A', -1]])).size, 0)
    assert.equal(subtractQty(m([['A', 1]]), m([['A', 1]])).size, 0)
  })

  it('subtractQty is the residual operator: delta − effects', () => {
    const delta = m([['A', 2], ['B', -1]])
    const effects = m([['A', 2]])
    const residual = subtractQty(delta, effects)
    assert.deepEqual([...residual.entries()], [['B', -1]])
  })

  it('spans the union of both key sets', () => {
    const r = subtractQty(m([['A', 1]]), m([['B', 1]]))
    assert.equal(r.get('A'), 1)
    assert.equal(r.get('B'), -1)
  })
})

describe('qtyToJson / qtyFromJson — the position_snapshots.symbols round-trip', () => {
  it('round-trips a map exactly', () => {
    const q = m([['SPY   260911P00750000', 1], ['SPY   260911P00765000', -1]])
    assert.deepEqual([...qtyFromJson(qtyToJson(q)).entries()].sort(), [...q.entries()].sort())
  })

  it('survives jsonb KEY REORDERING — compare structurally, never by JSON text', () => {
    // jsonb reorders object keys on storage (confirmed live 2026-08-07 on
    // sweep_runs.report). A Map rebuilt from an object is order-insensitive by
    // construction, so a stored snapshot equals a fresh one even though the
    // serialized text differs.
    const a = qtyFromJson({ ZZZ: 1, AAA: -2 })
    const b = qtyFromJson({ AAA: -2, ZZZ: 1 })
    assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort())
    assert.notEqual(JSON.stringify(qtyToJson(a)), JSON.stringify(qtyToJson(b)))
  })

  it('drops zero entries on read so a stored zero cannot resurrect as held', () => {
    assert.equal(qtyFromJson({ A: 0, B: 1 }).size, 1)
  })

  it('ignores non-numeric and non-finite values rather than coercing them', () => {
    const q = qtyFromJson({ A: 'two', B: null, C: NaN, D: 3 })
    assert.deepEqual([...q.entries()], [['D', 3]])
  })

  it('a null or non-object payload yields an EMPTY map, never a throw', () => {
    // The caller must still branch on "no snapshot row" (UNANCHORED) before
    // reaching here — an empty map from a MISSING anchor would balance against
    // empty effects and manufacture a false proof.
    assert.equal(qtyFromJson(null).size, 0)
    assert.equal(qtyFromJson('nonsense').size, 0)
  })
})

describe('formatQty', () => {
  it('is stable and sorted, with explicit signs', () => {
    assert.equal(formatQty(m([['B', -2], ['A', 1]])), 'A +1, B -2')
  })

  it('says (empty) rather than rendering nothing', () => {
    assert.equal(formatQty(m([])), '(empty)')
  })
})
