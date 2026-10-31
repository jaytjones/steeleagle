// ============================================================
// SteelEagle — v2.16 roll-price edit planner
//
// The anchor is real: the v2.15 replay found trade 7dc07054's Aug 5 roll
// (order 1007483420023) hand-typed at SP 5.79 / LP 3.66 where Schwab executed
// 5.77 / 3.69 — a ~$5 overstatement this edit exists to repair.
// ============================================================

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { isEditableRollEvent, planRollEdit, previewRollEditTotals } from './edit-roll'
import { deriveTotals } from './trade-math'
import type { TradeEvent } from './types'

const AT = '2026-08-05T17:56:00.000Z'
const E = '2026-09-11'

function event(over: Partial<TradeEvent> & { id: string }): TradeEvent {
  return {
    tradeId: '7dc07054-0000-0000-0000-000000000000',
    eventType: 'roll_open',
    leg: 'short_put',
    strike: 750,
    expiration: E,
    delta: null,
    contracts: 1,
    price: 0,
    creditDebit: 'credit',
    amount: 0,
    source: 'manual',
    schwabOrderId: null,
    occurredAt: AT,
    notes: null,
    createdAt: AT,
    ...over,
  }
}

const LOG: TradeEvent[] = [
  event({ id: 'o-lp', eventType: 'open', leg: 'long_put', strike: 700, price: 1.2, creditDebit: 'debit', amount: 120, occurredAt: '2026-07-31T19:24:00.000Z' }),
  event({ id: 'c-sp', eventType: 'close', leg: 'short_put', strike: 715, price: 0.5, creditDebit: 'debit', amount: 50 }),
  event({ id: 'rc-sp', eventType: 'roll_close', leg: 'short_put', strike: 740, price: 4.26, creditDebit: 'debit', amount: 426 }),
  event({ id: 'rc-lp', eventType: 'roll_close', leg: 'long_put', strike: 725, price: 2.8, creditDebit: 'credit', amount: 280 }),
  event({ id: 'ro-sp', eventType: 'roll_open', leg: 'short_put', strike: 750, price: 5.79, creditDebit: 'credit', amount: 579 }),
  event({ id: 'ro-lp', eventType: 'roll_open', leg: 'long_put', strike: 735, price: 3.66, creditDebit: 'debit', amount: 366, source: 'schwab_fill', schwabOrderId: '1007483420023' }),
]

describe('planRollEdit — the 7dc07054 repair', () => {
  it('re-prices both legs; amount derived from the STORED contracts', () => {
    const u = planRollEdit(LOG, [{ id: 'ro-sp', price: 5.77 }, { id: 'ro-lp', price: 3.69 }], null)
    assert.deepEqual(
      u.map((x) => [x.id, x.price, x.amount]),
      [['ro-sp', 5.77, 577], ['ro-lp', 3.69, 369]],
    )
  })

  it('the preview moves net credit by exactly the overstatement (-$5)', () => {
    const before = deriveTotals(LOG)
    const after = previewRollEditTotals(LOG, [{ id: 'ro-sp', price: 5.77 }, { id: 'ro-lp', price: 3.69 }], null)
    assert.equal(+(after.credit - after.debit - (before.credit - before.debit)).toFixed(2), -5)
  })

  it('a schwab_fill leg is demoted to manual; a manual one is not touched', () => {
    const u = planRollEdit(LOG, [{ id: 'ro-sp', price: 5.77 }, { id: 'ro-lp', price: 3.69 }], null)
    assert.deepEqual(u.map((x) => x.demoteToManual), [false, true])
  })

  it('$0.00 is a legal roll price', () => {
    assert.equal(planRollEdit(LOG, [{ id: 'rc-lp', price: 0 }], null)[0].amount, 0)
  })

  it('a 2-lot leg derives a 2-lot amount', () => {
    const two = LOG.map((e) => (e.id === 'ro-sp' ? { ...e, contracts: 2 } : e))
    assert.equal(planRollEdit(two, [{ id: 'ro-sp', price: 5.77 }], null)[0].amount, 1154)
  })
})

describe('planRollEdit — refusals (the whole edit, never part of it)', () => {
  it('a STANDING GTC refuses — it was priced from the credit this would change (JJ, 2026-10-31)', () => {
    assert.throws(
      () => planRollEdit(LOG, [{ id: 'ro-sp', price: 5.77 }], '1007000000001'),
      /standing GTC 1007000000001.*Cancel the GTC from the Positions Monitor first/,
    )
  })

  it('an entry leg refuses', () => {
    assert.throws(() => planRollEdit(LOG, [{ id: 'o-lp', price: 1 }], null), /open leg.*roll prices only/)
  })

  it('a close leg refuses — closes have their own edit', () => {
    assert.throws(() => planRollEdit(LOG, [{ id: 'c-sp', price: 1 }], null), /close leg/)
  })

  it('one bad id refuses the batch', () => {
    assert.throws(
      () => planRollEdit(LOG, [{ id: 'ro-sp', price: 5.77 }, { id: 'nope', price: 1 }], null),
      /not part of this trade/,
    )
  })

  it('a duplicate id refuses', () => {
    assert.throws(
      () => planRollEdit(LOG, [{ id: 'ro-sp', price: 5.77 }, { id: 'ro-sp', price: 5.78 }], null),
      /appears twice/,
    )
  })

  it('an empty submission refuses', () => {
    assert.throws(() => planRollEdit(LOG, [], null), /no roll legs/)
  })
})

describe('isEditableRollEvent', () => {
  it('roll_close and roll_open only', () => {
    assert.deepEqual(
      (['open', 'close', 'roll_close', 'roll_open'] as const).map((t) => isEditableRollEvent({ eventType: t })),
      [false, false, true, true],
    )
  })
})
