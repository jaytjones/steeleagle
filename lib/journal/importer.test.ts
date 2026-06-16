/**
 * Run with:  npx tsx --test lib/journal/importer.test.ts
 *
 * Pure-function tests for the Schwab position importer (Session 10 — §8).
 * No Schwab / DB mocks needed — every tested function is pure.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePositionLegs,
  groupIntoCondors,
  enrichWithOrderHistory,
  deduplicateCandidates,
} from './importer'
import type { ImportCandidate, RawPositionLeg } from './types'
import type { SchwabOrder } from '@/lib/schwab/orders'

// --------------------------------------------------------
// Fixtures — a clean SPY iron condor (LP 560 / SP 565 / SC 580 / LC 585).
// --------------------------------------------------------
const OCC = {
  lp: 'SPY   250117P00560000',
  sp: 'SPY   250117P00565000',
  sc: 'SPY   250117C00580000',
  lc: 'SPY   250117C00585000',
}

function optionPosition(over: Record<string, unknown>) {
  return {
    instrument: {
      assetType: 'OPTION',
      symbol: 'SPY   250117P00560000',
      putCall: 'PUT',
      underlyingSymbol: 'SPY',
      strikePrice: 560,
      expirationDate: '2025-01-17',
    },
    longQuantity: 0,
    shortQuantity: 0,
    averagePrice: 0,
    ...over,
  }
}

/** A full 4-leg SPY condor as raw position legs (1 contract each). */
function spyCondorLegs(): RawPositionLeg[] {
  return [
    { occSymbol: OCC.lp, underlying: 'SPY', putCall: 'PUT', strike: 560, expiration: '2025-01-17', longQty: 1, shortQty: 0, averagePrice: 0.42 },
    { occSymbol: OCC.sp, underlying: 'SPY', putCall: 'PUT', strike: 565, expiration: '2025-01-17', longQty: 0, shortQty: 1, averagePrice: 0.88 },
    { occSymbol: OCC.sc, underlying: 'SPY', putCall: 'CALL', strike: 580, expiration: '2025-01-17', longQty: 0, shortQty: 1, averagePrice: 0.97 },
    { occSymbol: OCC.lc, underlying: 'SPY', putCall: 'CALL', strike: 585, expiration: '2025-01-17', longQty: 1, shortQty: 0, averagePrice: 0.45 },
  ]
}

// --------------------------------------------------------
// parsePositionLegs
// --------------------------------------------------------
describe('parsePositionLegs', () => {
  it('filters out non-OPTION asset types', () => {
    const legs = parsePositionLegs([
      optionPosition({ shortQuantity: 1 }),
      { instrument: { assetType: 'EQUITY', symbol: 'SPY', underlyingSymbol: 'SPY' }, longQuantity: 100 },
    ])
    assert.equal(legs.length, 1)
    assert.equal(legs[0].occSymbol, OCC.lp)
  })

  it('filters out zero-quantity positions', () => {
    const legs = parsePositionLegs([
      optionPosition({ longQuantity: 0, shortQuantity: 0 }),
      optionPosition({ symbol: OCC.sc, longQuantity: 0, shortQuantity: 2 }),
    ])
    assert.equal(legs.length, 1)
    assert.equal(legs[0].shortQty, 2)
  })

  it('maps longQty / shortQty / strike / expiration onto RawPositionLeg', () => {
    const [leg] = parsePositionLegs([optionPosition({ shortQuantity: 3, averagePrice: 1.85 })])
    assert.equal(leg.underlying, 'SPY')
    assert.equal(leg.putCall, 'PUT')
    assert.equal(leg.strike, 560)
    assert.equal(leg.expiration, '2025-01-17')
    assert.equal(leg.longQty, 0)
    assert.equal(leg.shortQty, 3)
    assert.equal(leg.averagePrice, 1.85)
  })

  it('normalizes a timestamped expiration to YYYY-MM-DD', () => {
    const [leg] = parsePositionLegs([
      optionPosition({ shortQuantity: 1, instrument: { assetType: 'OPTION', symbol: OCC.lp, putCall: 'PUT', underlyingSymbol: 'SPY', strikePrice: 560, expirationDate: '2025-01-17T00:00:00.000+0000' } }),
    ])
    assert.equal(leg.expiration, '2025-01-17')
  })
})

// --------------------------------------------------------
// groupIntoCondors
// --------------------------------------------------------
describe('groupIntoCondors', () => {
  it('happy path: 4 legs → one candidate with correct LP/SP/SC/LC assignment', () => {
    const { candidates, incomplete } = groupIntoCondors(spyCondorLegs())
    assert.equal(incomplete.length, 0)
    assert.equal(candidates.length, 1)
    const c = candidates[0]
    assert.equal(c.candidateId, 'SPY-2025-01-17')
    assert.equal(c.contracts, 1)
    assert.equal(c.longPut.strike, 560)
    assert.equal(c.longPut.action, 'BUY')
    assert.equal(c.shortPut.strike, 565)
    assert.equal(c.shortPut.action, 'SELL')
    assert.equal(c.shortCall.strike, 580)
    assert.equal(c.shortCall.action, 'SELL')
    assert.equal(c.longCall.strike, 585)
    assert.equal(c.longCall.action, 'BUY')
    assert.equal(c.confidence, 'marks_only')
    assert.equal(c.openDate, null)
    // marks-only prices come straight from averagePrice
    assert.equal(c.shortPut.price, 0.88)
  })

  it('returns IncompletePosition when a group has 3 legs', () => {
    const { candidates, incomplete } = groupIntoCondors(spyCondorLegs().slice(0, 3))
    assert.equal(candidates.length, 0)
    assert.equal(incomplete.length, 1)
    assert.equal(incomplete[0].legsFound, 3)
    assert.match(incomplete[0].reason, /partial close/i)
  })

  it('returns IncompletePosition on mismatched quantities', () => {
    const legs = spyCondorLegs()
    legs[1].shortQty = 2 // short put now 2 contracts vs 1 elsewhere
    const { candidates, incomplete } = groupIntoCondors(legs)
    assert.equal(candidates.length, 0)
    assert.equal(incomplete.length, 1)
    assert.match(incomplete[0].reason, /mismatched quantities/i)
  })

  it('returns IncompletePosition when a group has 2 puts and 0 calls', () => {
    const legs = spyCondorLegs()
    // Turn the two calls into puts → 4 puts, 0 calls.
    legs[2] = { ...legs[2], putCall: 'PUT' }
    legs[3] = { ...legs[3], putCall: 'PUT' }
    const { candidates, incomplete } = groupIntoCondors(legs)
    assert.equal(candidates.length, 0)
    assert.equal(incomplete.length, 1)
    assert.match(incomplete[0].reason, /put|call/i)
  })

  it('flags a 4-leg group whose strikes are not ordered as a condor', () => {
    const legs = spyCondorLegs()
    // Move the long put inside the short put (560 → 570) — breaks LP < SP.
    legs[0].strike = 570
    const { candidates, incomplete } = groupIntoCondors(legs)
    assert.equal(candidates.length, 0)
    assert.equal(incomplete.length, 1)
    assert.match(incomplete[0].reason, /ordered/i)
  })

  it('multiple underlying/expiration groups → multiple candidates', () => {
    const tltLegs: RawPositionLeg[] = spyCondorLegs().map((l) => ({
      ...l,
      underlying: 'TLT',
      expiration: '2025-02-21',
      occSymbol: l.occSymbol.replace('SPY', 'TLT').replace('250117', '250221'),
    }))
    const { candidates, incomplete } = groupIntoCondors([...spyCondorLegs(), ...tltLegs])
    assert.equal(incomplete.length, 0)
    assert.equal(candidates.length, 2)
    assert.deepEqual(candidates.map((c) => c.candidateId).sort(), ['SPY-2025-01-17', 'TLT-2025-02-21'])
  })
})

// --------------------------------------------------------
// enrichWithOrderHistory
// --------------------------------------------------------
/** A single 4-leg FILLED open order for the SPY condor. */
function spyOpenOrder(over?: Partial<SchwabOrder>): SchwabOrder {
  return {
    orderId: 123456789,
    enteredTime: '2025-01-03T10:31:00+00:00',
    status: 'FILLED',
    orderLegCollection: [
      { legId: 1, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { symbol: OCC.lp, putCall: 'PUT' } },
      { legId: 2, instruction: 'SELL_TO_OPEN', quantity: 1, instrument: { symbol: OCC.sp, putCall: 'PUT' } },
      { legId: 3, instruction: 'SELL_TO_OPEN', quantity: 1, instrument: { symbol: OCC.sc, putCall: 'CALL' } },
      { legId: 4, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { symbol: OCC.lc, putCall: 'CALL' } },
    ],
    orderActivityCollection: [
      {
        executionLegs: [
          { legId: 1, price: 0.40 },
          { legId: 2, price: 0.90 },
          { legId: 3, price: 1.00 },
          { legId: 4, price: 0.43 },
        ],
      },
    ],
    ...over,
  }
}

describe('enrichWithOrderHistory', () => {
  it('matched order: confidence becomes matched, prices from executionLegs, orderId + openDate set', () => {
    const [c] = groupIntoCondors(spyCondorLegs()).candidates
    const [enriched] = enrichWithOrderHistory([c], [spyOpenOrder()])
    assert.equal(enriched.confidence, 'matched')
    assert.equal(enriched.schwabOrderId, 123456789)
    assert.equal(enriched.openDate, '2025-01-03')
    assert.equal(enriched.splitOrder, false)
    assert.equal(enriched.longPut.price, 0.40)
    assert.equal(enriched.shortPut.price, 0.90)
    assert.equal(enriched.shortCall.price, 1.00)
    assert.equal(enriched.longCall.price, 0.43)
  })

  it('unmatched order: confidence stays marks_only, prices unchanged', () => {
    const [c] = groupIntoCondors(spyCondorLegs()).candidates
    const unrelated = spyOpenOrder({
      orderLegCollection: [
        { legId: 1, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { symbol: 'QQQ   250117P00400000', putCall: 'PUT' } },
      ],
      orderActivityCollection: [{ executionLegs: [{ legId: 1, price: 1.0 }] }],
    })
    const [enriched] = enrichWithOrderHistory([c], [unrelated])
    assert.equal(enriched.confidence, 'marks_only')
    assert.equal(enriched.openDate, null)
    assert.equal(enriched.shortPut.price, 0.88) // averagePrice untouched
  })

  it('split-order case: two 2-leg orders → matched, splitOrder true, openDate from earlier order', () => {
    const putSpread = spyOpenOrder({
      orderId: 111,
      enteredTime: '2025-01-03T10:31:00+00:00',
      orderLegCollection: [
        { legId: 1, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { symbol: OCC.lp, putCall: 'PUT' } },
        { legId: 2, instruction: 'SELL_TO_OPEN', quantity: 1, instrument: { symbol: OCC.sp, putCall: 'PUT' } },
      ],
      orderActivityCollection: [{ executionLegs: [{ legId: 1, price: 0.40 }, { legId: 2, price: 0.90 }] }],
    })
    const callSpread = spyOpenOrder({
      orderId: 222,
      enteredTime: '2025-01-04T14:02:00+00:00',
      orderLegCollection: [
        { legId: 1, instruction: 'SELL_TO_OPEN', quantity: 1, instrument: { symbol: OCC.sc, putCall: 'CALL' } },
        { legId: 2, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { symbol: OCC.lc, putCall: 'CALL' } },
      ],
      orderActivityCollection: [{ executionLegs: [{ legId: 1, price: 1.00 }, { legId: 2, price: 0.43 }] }],
    })
    const [c] = groupIntoCondors(spyCondorLegs()).candidates
    const [enriched] = enrichWithOrderHistory([c], [callSpread, putSpread]) // out of order on purpose
    assert.equal(enriched.confidence, 'matched')
    assert.equal(enriched.splitOrder, true)
    assert.equal(enriched.openDate, '2025-01-03') // earlier of the two
    assert.equal(enriched.schwabOrderId, 111)
    assert.equal(enriched.shortCall.price, 1.00)
  })

  it('executionLeg price = 0 on a leg → falls back to averagePrice, confidence marks_only', () => {
    const order = spyOpenOrder({
      orderActivityCollection: [
        { executionLegs: [{ legId: 1, price: 0.40 }, { legId: 2, price: 0 }, { legId: 3, price: 1.0 }, { legId: 4, price: 0.43 }] },
      ],
    })
    const [c] = groupIntoCondors(spyCondorLegs()).candidates
    const [enriched] = enrichWithOrderHistory([c], [order])
    assert.equal(enriched.confidence, 'marks_only')
    assert.equal(enriched.shortPut.price, 0.88) // averagePrice retained
    assert.equal(enriched.openDate, null)
  })

  it('empty order history leaves candidates untouched', () => {
    const [c] = groupIntoCondors(spyCondorLegs()).candidates
    const [enriched] = enrichWithOrderHistory([c], [])
    assert.equal(enriched.confidence, 'marks_only')
  })
})

// --------------------------------------------------------
// deduplicateCandidates
// --------------------------------------------------------
describe('deduplicateCandidates', () => {
  const candidate = (): ImportCandidate => groupIntoCondors(spyCondorLegs()).candidates[0]

  it('candidate matching an open journal trade → alreadyImported', () => {
    const { fresh, alreadyImported } = deduplicateCandidates(
      [candidate()],
      [{ underlying: 'SPY', currentExpiration: '2025-01-17' }],
    )
    assert.equal(fresh.length, 0)
    assert.equal(alreadyImported.length, 1)
  })

  it('candidate not in journal → stays fresh', () => {
    const { fresh, alreadyImported } = deduplicateCandidates(
      [candidate()],
      [{ underlying: 'SPY', currentExpiration: '2025-02-21' }],
    )
    assert.equal(fresh.length, 1)
    assert.equal(alreadyImported.length, 0)
  })

  it('empty journal → all candidates fresh', () => {
    const { fresh, alreadyImported } = deduplicateCandidates([candidate()], [])
    assert.equal(fresh.length, 1)
    assert.equal(alreadyImported.length, 0)
  })
})
