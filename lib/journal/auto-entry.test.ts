// ============================================================
// SteelEagle — v2.16 auto-entry planner + entry-from-fill mapper
//
// The anchor is GLD_ENTRY (order 1007457102802): the SECOND GLD 2026-09-18
// condor, the scale-in Import could not see and JJ typed by hand 69 hours
// late. Trade A was order 1007426750012 at the same strikes.
// ============================================================

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { autoEntryNote, planAutoEntries, summarizeAutoEntry, type AutoEntryTrade } from './auto-entry'
import { entryDisagreement, entryInputFromFill } from './entry-from-fill'
import { classifyFill, type FillClassification } from './classify-fill'
import { GOLDEN_FILLS } from './golden-fills.fixture'
import { NewTradeSchema } from './types'

const { GLD_ENTRY, SPY_ROLL_CONDOR, SPY_BUTTERFLY_CLOSE, SPY_CANCELED_GTC, SWVXX_CASH_SWEEP } = GOLDEN_FILLS

const E = '2026-09-18'
const AUG4 = { from: new Date('2026-08-03T21:15:00Z'), to: new Date('2026-08-04T21:15:00Z') }

const gldTrade = (id: string, orderId: string | null): AutoEntryTrade => ({
  id,
  symbol: 'GLD',
  events: [
    { eventType: 'open', leg: 'long_put', strike: 330, expiration: E, schwabOrderId: orderId },
    { eventType: 'open', leg: 'short_put', strike: 350, expiration: E, schwabOrderId: orderId },
    { eventType: 'open', leg: 'short_call', strike: 400, expiration: E, schwabOrderId: orderId },
    { eventType: 'open', leg: 'long_call', strike: 420, expiration: E, schwabOrderId: orderId },
  ],
})
const TRADE_A = gldTrade('9b3f575a-0000-0000-0000-000000000000', '1007426750012')

const plan = (over: Partial<Parameters<typeof planAutoEntries>[0]> = {}) =>
  planAutoEntries({
    fills: [{ classification: classifyFill(GLD_ENTRY), disposition: 'pending' }],
    trades: [],
    interval: AUG4,
    balanceStatus: 'BALANCED',
    ...over,
  })

describe('entryInputFromFill — the live GLD entry', () => {
  const entry = () => entryInputFromFill(classifyFill(GLD_ENTRY), 'n')

  it('maps legs with F3 roles, SELL = credit, Schwab prices, null deltas', () => {
    const e = entry()
    assert.equal(e.symbol, 'GLD')
    assert.equal(e.initialExpiration, E)
    assert.equal(e.contracts, 1)
    assert.equal(e.openedAt, '2026-08-04T15:40:43.000Z')
    assert.deepEqual(
      [...e.legs].sort((a, b) => a.strike - b.strike).map((l) => [l.leg, l.strike, l.price, l.creditDebit, l.delta]),
      [
        ['long_put', 330, 0.92, 'debit', null],
        ['short_put', 350, 2.75, 'credit', null],
        ['short_call', 400, 3.72, 'credit', null],
        ['long_call', 420, 1.41, 'debit', null],
      ],
    )
  })

  it('BPR is DERIVED: 20-wide wing × 100 − $414 credit = $1586', () => {
    assert.equal(entry().initialBpr, 1586)
  })

  it('carries schwab_fill provenance with the order id — same as Import', () => {
    assert.equal(entry().source, 'schwab_fill')
    assert.equal(entry().schwabOrderId, '1007457102802')
  })

  it('passes NewTradeSchema — the schema every entry path enforces', () => {
    const r = NewTradeSchema.safeParse(entry())
    assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.issues))
  })

  it('a null price refuses — never invented', () => {
    const c = classifyFill(GLD_ENTRY)
    const bad: FillClassification = { ...c, legs: c.legs.map((l, i) => (i === 0 ? { ...l, price: null } : l)) }
    assert.throws(() => entryInputFromFill(bad, 'n'), /invented price/)
  })

  it('a butterfly ENTRY refuses — the app never opens one (v2.7.1)', () => {
    const c = classifyFill(GLD_ENTRY)
    const fly: FillClassification = {
      ...c,
      legs: c.legs.map((l) => (l.role === 'short_call' ? { ...l, strike: 350 } : l.role === 'long_call' ? { ...l, strike: 370 } : l)),
    }
    assert.throws(() => entryInputFromFill(fly, 'n'), /butterfly/)
  })

  it('an underivable BPR refuses — never the 0.01 floor', () => {
    const c = classifyFill(GLD_ENTRY)
    // A credit bigger than the wing: wing − credit ≤ 0.
    const rich: FillClassification = { ...c, legs: c.legs.map((l) => (l.role === 'short_put' ? { ...l, price: 30 } : l)) }
    assert.throws(() => entryInputFromFill(rich, 'n'), /could not be derived/)
  })

  it('a roll or a close is not an entry', () => {
    assert.throws(() => entryInputFromFill(classifyFill(SPY_ROLL_CONDOR), 'n'), /not a four-leg entry/)
    assert.throws(() => entryInputFromFill(classifyFill(SPY_BUTTERFLY_CLOSE), 'n'), /not a four-leg entry/)
  })

  it('entryDisagreement: identical agrees, a moved price is named', () => {
    assert.equal(entryDisagreement(entry(), entry()), null)
    const moved = { ...entry(), legs: entry().legs.map((l) => (l.leg === 'short_put' ? { ...l, price: 2.8 } : l)) }
    assert.match(entryDisagreement(entry(), moved)!, /legs:/)
    assert.match(entryDisagreement(entry(), { ...entry(), initialBpr: 1600 })!, /initialBpr/)
  })
})

describe('planAutoEntries — the gate and the skips', () => {
  it('a BALANCED interval with a brand-new entry writes it, with the auto note', () => {
    const p = plan()
    assert.equal(p.gate, 'OPEN')
    assert.equal(p.write.length, 1)
    assert.equal(p.write[0].orderId, '1007457102802')
    assert.equal(p.write[0].input.notes, autoEntryNote('1007457102802'))
  })

  for (const status of ['RESIDUAL', 'UNRELIABLE', null]) {
    it(`${status ?? 'null'} shuts the gate`, () => {
      const p = plan({ balanceStatus: status })
      assert.equal(p.gate, 'CLOSED')
      assert.equal(p.write.length, 0)
    })
  }

  it('an entry already journaled under THIS order id is skipped (Import got there first)', () => {
    const p = plan({ trades: [gldTrade('bbbbbbbb-0000-0000-0000-000000000000', '1007457102802')] })
    assert.equal(p.write.length, 0)
    assert.deepEqual(p.refused, [])
  })

  it('a dismissed fill, a fill outside the interval, a roll, a cancel and SWVXX are not candidates', () => {
    const fills = [
      { classification: classifyFill(GLD_ENTRY), disposition: 'dismissed' },
      { classification: classifyFill(SPY_ROLL_CONDOR), disposition: 'pending' },
      { classification: classifyFill(SPY_CANCELED_GTC), disposition: 'pending' },
      { classification: classifyFill(SWVXX_CASH_SWEEP), disposition: 'pending' },
    ]
    const p = plan({ fills })
    assert.equal(p.considered, 0)
    assert.equal(
      plan({ interval: { from: new Date('2026-08-04T21:15:00Z'), to: new Date('2026-08-05T21:15:00Z') } }).considered,
      0,
    )
  })
})

describe('planAutoEntries — scale-ins (JJ, 2026-10-31: journal as a new trade)', () => {
  it('THE GLD CASE: same strikes as trade A, which carries a DIFFERENT order id → written', () => {
    const p = plan({ trades: [TRADE_A] })
    assert.deepEqual(p.refused, [])
    assert.equal(p.write.length, 1)
  })

  it('a same-strike trade with NO order id refuses — a hand-typed copy looks identical', () => {
    const p = plan({ trades: [TRADE_A, gldTrade('cccccccc-0000-0000-0000-000000000000', null)] })
    assert.equal(p.write.length, 0)
    assert.match(p.refused[0].reason, /no Schwab order id on record.*hand-typed copy/)
  })

  it('a same-strike trade on a DIFFERENT underlying is not a holder', () => {
    const p = plan({ trades: [{ ...gldTrade('dddddddd-0000-0000-0000-000000000000', null), symbol: 'SLV' }] })
    assert.equal(p.write.length, 1)
  })
})

describe('summarizeAutoEntry', () => {
  it('a write, a held gate and an idle run all read differently', () => {
    assert.match(summarizeAutoEntry(plan()), /1 entry\(ies\) journaled automatically, GTC held/)
    assert.match(summarizeAutoEntry(plan({ balanceStatus: 'RESIDUAL' })), /held/)
    assert.match(
      summarizeAutoEntry(plan({ trades: [gldTrade('e', '1007457102802')] })),
      /nothing to do — 1 filled entry/,
    )
  })
})
