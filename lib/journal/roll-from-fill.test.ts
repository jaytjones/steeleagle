// ============================================================
// SteelEagle — v2.15 roll-from-fill mapper
//
// Every expectation below is read off Schwab's own record of a real roll. If
// one fails after a refactor, the REFACTOR is wrong.
// ============================================================

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { rollDisagreement, rollInputFromFill } from './roll-from-fill'
import { classifyFill, type FillClassification } from './classify-fill'
import { GOLDEN_FILLS } from './golden-fills.fixture'
import { RollTradeSchema } from './types'

const {
  SPY_ROLL_CONDOR,
  SPY_ROLL_CUSTOM,
  SPY_ROLL_0828_TO_FLY,
  GLD_ROLL_TWO_LOT_FIRST,
  SPY_SPLIT_CLOSE,
  SPY_CANCELED_GTC,
  SPY_BUTTERFLY_CLOSE,
} = GOLDEN_FILLS

describe('rollInputFromFill — the live payloads', () => {
  it('SPY 09-11 put roll 700/715 → 725/740: closes first, F3 roles, BUY = debit', () => {
    const r = rollInputFromFill(classifyFill(SPY_ROLL_CONDOR))
    assert.equal(r.contracts, 1)
    assert.equal(r.occurredAt, '2026-08-04T14:39:22.000Z')
    assert.deepEqual(
      r.events.map((e) => [e.eventType, e.leg, e.strike, e.expiration, e.price, e.creditDebit]),
      [
        ['roll_close', 'short_put', 715, '2026-09-11', 2.49, 'debit'],
        ['roll_close', 'long_put', 700, '2026-09-11', 1.74, 'credit'],
        ['roll_open', 'short_put', 740, '2026-09-11', 5.05, 'credit'],
        ['roll_open', 'long_put', 725, '2026-09-11', 3.25, 'debit'],
      ],
    )
  })

  it('the CUSTOM-labelled twin maps identically in shape — the label is never read (F2)', () => {
    const r = rollInputFromFill(classifyFill(SPY_ROLL_CUSTOM))
    assert.deepEqual(
      r.events.map((e) => [e.eventType, e.leg, e.strike]),
      [
        ['roll_close', 'short_put', 740],
        ['roll_close', 'long_put', 725],
        ['roll_open', 'short_put', 750],
        ['roll_open', 'long_put', 735],
      ],
    )
  })

  it('out-of-order executionLegs still price each leg by legId', () => {
    const r = rollInputFromFill(classifyFill(SPY_ROLL_0828_TO_FLY))
    const by = Object.fromEntries(r.events.map((e) => [`${e.eventType}:${e.leg}`, e.price]))
    assert.deepEqual(by, {
      'roll_close:short_put': 2.59,
      'roll_close:long_put': 1.32,
      'roll_open:short_put': 7.21,
      'roll_open:long_put': 3.13,
    })
  })

  it('a 2-lot ticket reports 2 contracts', () => {
    assert.equal(rollInputFromFill(classifyFill(GLD_ROLL_TWO_LOT_FIRST)).contracts, 2)
  })

  it('its output passes RollTradeSchema — the same schema the Roll form enforces', () => {
    const r = rollInputFromFill(classifyFill(SPY_ROLL_CONDOR))
    const parsed = RollTradeSchema.safeParse({
      occurredAt: r.occurredAt,
      newExpiration: null,
      events: r.events,
    })
    assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues))
  })
})

describe('rollInputFromFill — refusals', () => {
  const roll = () => classifyFill(SPY_ROLL_CONDOR)

  it('a split-roll half is not a single-ticket roll', () => {
    assert.throws(() => rollInputFromFill(classifyFill(SPY_SPLIT_CLOSE)), /PARTIAL_CLOSE, not a single-ticket ROLL/)
  })

  it('a pure close is not a roll', () => {
    assert.throws(() => rollInputFromFill(classifyFill(SPY_BUTTERFLY_CLOSE)), /CONDOR_CLOSE/)
  })

  it('a cancellation is never journaled — nothing executed', () => {
    assert.throws(() => rollInputFromFill(classifyFill(SPY_CANCELED_GTC)), /not a single-ticket ROLL|did not fully execute/)
  })

  it('a null price REFUSES — never a fabricated $0.00', () => {
    const f = roll()
    const bad: FillClassification = { ...f, legs: f.legs.map((l, i) => (i === 0 ? { ...l, price: null } : l)) }
    assert.throws(() => rollInputFromFill(bad), /invented price/)
  })

  it('a leg short of the ticket quantity is a partial and refuses', () => {
    const f = roll()
    const bad: FillClassification = {
      ...f,
      contracts: 2,
      legs: f.legs.map((l) => ({ ...l, contracts: 2 })).map((l, i) => (i === 1 ? { ...l, contracts: 1 } : l)),
    }
    assert.throws(() => rollInputFromFill(bad), /partial rolls/)
  })

  it('mixed expirations (a roll out in time) refuse', () => {
    assert.throws(() => rollInputFromFill({ ...roll(), expiration: null }), /roll out in time/)
  })

  it('a non-FILLED status refuses', () => {
    assert.throws(() => rollInputFromFill({ ...roll(), status: 'WORKING' }), /did not fully execute/)
  })
})

describe('rollInputFromFill — v2.11 F3 guard', () => {
  it("never imports close-from-fill — its `short = BUY` legRole inverts a roll's new long", () => {
    const src = readFileSync(join(__dirname, 'roll-from-fill.ts'), 'utf8')
    assert.doesNotMatch(src, /from '\.\/close-from-fill'/)
  })
})

describe('rollDisagreement — the write-time cross-check', () => {
  const r = () => rollInputFromFill(classifyFill(SPY_ROLL_CONDOR))

  it('the same order agrees with itself', () => {
    assert.equal(rollDisagreement(r(), r()), null)
  })

  it('a moved price is named', () => {
    const live = r()
    live.events[2] = { ...live.events[2], price: 5.1 }
    assert.match(rollDisagreement(r(), live)!, /leg 3: .*5\.05.*5\.1/)
  })

  it('a contract change is named', () => {
    assert.match(rollDisagreement(r(), { ...r(), contracts: 2 })!, /contracts: planned 1, live order 2/)
  })
})
