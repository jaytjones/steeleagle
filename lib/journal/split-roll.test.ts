// ============================================================
// SteelEagle — v2.16 split-roll pairing (prefill only)
//
// The anchor is the only live split roll: SPY 2026-09-11, 2026-08-14 —
// 1007598808689 (close 750/735) and 1007598809002 (open 765/750), 4m28s apart.
// ============================================================

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { pairSplitRoll, splitRollToPrefill, SPLIT_ROLL_WINDOW_MIN } from './split-roll'
import { classifyFill, type FillClassification } from './classify-fill'
import { GOLDEN_FILLS } from './golden-fills.fixture'
import { RollTradeSchema } from './types'

const { SPY_SPLIT_CLOSE, SPY_SPLIT_OPEN, SPY_ROLL_CONDOR } = GOLDEN_FILLS
const close = () => classifyFill(SPY_SPLIT_CLOSE)
const open = () => classifyFill(SPY_SPLIT_OPEN)

describe('pairSplitRoll — the live Aug 14 pair', () => {
  it('pairs in both directions', () => {
    assert.equal(pairSplitRoll(close(), [open()]).partner?.orderId, '1007598809002')
    assert.equal(pairSplitRoll(open(), [close()]).partner?.orderId, '1007598808689')
  })

  it('ignores the ticket itself and unrelated fills', () => {
    const p = pairSplitRoll(close(), [close(), classifyFill(SPY_ROLL_CONDOR), open()])
    assert.equal(p.partner?.orderId, '1007598809002')
  })
})

describe('pairSplitRoll — never pair wrongly', () => {
  const shift = (f: FillClassification, minutes: number): FillClassification => ({
    ...f,
    occurredAt: new Date(Date.parse(f.occurredAt) + minutes * 60_000).toISOString(),
  })

  it('outside the window: no partner', () => {
    const p = pairSplitRoll(close(), [shift(open(), SPLIT_ROLL_WINDOW_MIN + 1)])
    assert.equal(p.partner, null)
    assert.match(p.reason!, /within 30 minutes/)
  })

  it('TWO candidates: no pairing — ambiguity is not guessed', () => {
    const p = pairSplitRoll(close(), [open(), { ...open(), orderId: '1007000000001' }])
    assert.equal(p.partner, null)
    assert.match(p.reason!, /2 possible partner tickets/)
  })

  it('a different contract count, expiration or role set does not pair', () => {
    assert.equal(pairSplitRoll(close(), [{ ...open(), contracts: 2 }]).partner, null)
    assert.equal(pairSplitRoll(close(), [{ ...open(), expiration: '2026-09-18' }]).partner, null)
    const callSide: FillClassification = {
      ...open(),
      legs: open().legs.map((l) => ({ ...l, putCall: 'CALL' as const, role: l.role === 'short_put' ? 'short_call' as const : 'long_call' as const })),
    }
    assert.equal(pairSplitRoll(close(), [callSide]).partner, null)
  })

  it('a single-ticket roll is not a half', () => {
    assert.match(pairSplitRoll(classifyFill(SPY_ROLL_CONDOR), [open()]).reason!, /not a filled split-roll half/)
  })
})

describe('splitRollToPrefill', () => {
  it('one Roll form: closes first, real prices, the LATER ticket time, both order ids', () => {
    const p = splitRollToPrefill(open(), close())
    assert.equal(p.mode, 'roll')
    assert.equal(p.occurredAt, open().occurredAt)
    assert.match(p.notes, /1007598808689 \(close\) \+ 1007598809002 \(open\)/)
    assert.deepEqual(
      p.rows.map((r) => [r.eventType, r.leg, r.strike, r.price, r.creditDebit]),
      [
        ['roll_close', 'short_put', '750', '3.14', 'debit'],
        ['roll_close', 'long_put', '735', '1.89', 'credit'],
        ['roll_open', 'short_put', '765', '5.60', 'credit'],
        ['roll_open', 'long_put', '750', '3.12', 'debit'],
      ],
    )
    assert.equal(p.hasMissingPrices, false)
  })

  it('the paired rows satisfy RollTradeSchema — every roll_open has its roll_close', () => {
    const p = splitRollToPrefill(close(), open())
    const r = RollTradeSchema.safeParse({
      occurredAt: p.occurredAt,
      events: p.rows.map((x) => ({ ...x, strike: Number(x.strike), price: Number(x.price), delta: null })),
    })
    assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.issues))
  })
})
