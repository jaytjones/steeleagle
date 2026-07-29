/**
 * Run with:  npx tsx --test lib/journal/edit-close.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isEditableCloseEvent,
  planCloseEdit,
  previewCloseEditTotals,
  type CloseEventPatch,
} from './edit-close'
import type { TradeEvent } from './types'

const AT = '2026-07-25T15:00:00.000Z'

function event(over: Partial<TradeEvent> & { id: string }): TradeEvent {
  return {
    tradeId: 'trade-1',
    eventType: 'close',
    leg: 'short_put',
    strike: 720,
    expiration: '2026-08-14',
    delta: null,
    contracts: 1,
    price: 0,
    creditDebit: 'debit',
    amount: 0,
    source: 'manual',
    schwabOrderId: null,
    occurredAt: AT,
    notes: null,
    createdAt: AT,
    ...over,
  }
}

// The SPY 8/14 shape from the Session 15 repair: a four-leg entry plus four
// close legs, three of which landed at $0.00.
const ENTRY = [
  event({ id: 'e-lp', eventType: 'open', leg: 'long_put', strike: 700, price: 0.6, creditDebit: 'debit', amount: 60 }),
  event({ id: 'e-sp', eventType: 'open', leg: 'short_put', strike: 720, price: 5.5, creditDebit: 'credit', amount: 550 }),
  event({ id: 'e-sc', eventType: 'open', leg: 'short_call', strike: 770, price: 4, creditDebit: 'credit', amount: 400 }),
  event({ id: 'e-lc', eventType: 'open', leg: 'long_call', strike: 790, price: 3.35, creditDebit: 'debit', amount: 335 }),
]
const CLOSES = [
  event({ id: 'c-lp', leg: 'long_put', strike: 700, price: 1.56, creditDebit: 'credit', amount: 156 }),
  event({ id: 'c-sp', leg: 'short_put', strike: 720, price: 0, creditDebit: 'debit', amount: 0 }),
  event({ id: 'c-sc', leg: 'short_call', strike: 770, price: 0, creditDebit: 'debit', amount: 0 }),
  event({ id: 'c-lc', leg: 'long_call', strike: 790, price: 0, creditDebit: 'credit', amount: 0 }),
]
const LOG = [...ENTRY, ...CLOSES]

const patch = (id: string, price: number, creditDebit: 'credit' | 'debit'): CloseEventPatch => ({
  id,
  price,
  creditDebit,
  occurredAt: AT,
})

describe('isEditableCloseEvent', () => {
  it('accepts a manual close leg', () => {
    assert.equal(isEditableCloseEvent(event({ id: 'x' })), true)
  })
  it('rejects entry and roll legs', () => {
    assert.equal(isEditableCloseEvent(event({ id: 'x', eventType: 'open' })), false)
    assert.equal(isEditableCloseEvent(event({ id: 'x', eventType: 'roll_close' })), false)
    assert.equal(isEditableCloseEvent(event({ id: 'x', eventType: 'roll_open' })), false)
  })
  it('rejects a Schwab-filled close leg', () => {
    assert.equal(isEditableCloseEvent(event({ id: 'x', source: 'schwab_fill' })), false)
  })
})

describe('planCloseEdit', () => {
  it('derives amount from the stored contract count, not the client', () => {
    const [u] = planCloseEdit(LOG, [patch('c-sp', 3.31, 'debit')])
    assert.equal(u.price, 3.31)
    assert.equal(u.amount, 331)
    assert.equal(u.creditDebit, 'debit')
    assert.equal(u.occurredAt, AT)
  })

  it('scales the amount by a multi-contract event', () => {
    const log = [event({ id: 'c-sp', contracts: 3 })]
    assert.equal(planCloseEdit(log, [patch('c-sp', 1.2, 'debit')])[0].amount, 360)
  })

  it('allows an explicit $0.00 repair', () => {
    assert.equal(planCloseEdit(LOG, [patch('c-lc', 0, 'credit')])[0].amount, 0)
  })

  it('allows flipping a mis-keyed direction', () => {
    assert.equal(planCloseEdit(LOG, [patch('c-lp', 1.56, 'credit')])[0].creditDebit, 'credit')
  })

  it('is a no-op plan for no patches', () => {
    assert.deepEqual(planCloseEdit(LOG, []), [])
  })

  it('refuses an id from another trade', () => {
    assert.throws(() => planCloseEdit(LOG, [patch('not-here', 1, 'debit')]), /not part of this trade/)
  })

  it('refuses an entry leg', () => {
    assert.throws(() => planCloseEdit(LOG, [patch('e-sp', 1, 'credit')]), /only close legs are editable/)
  })

  it('refuses a roll leg', () => {
    const log = [event({ id: 'r-1', eventType: 'roll_close' })]
    assert.throws(() => planCloseEdit(log, [patch('r-1', 1, 'debit')]), /only close legs are editable/)
  })

  it('refuses a Schwab-filled close leg by order id', () => {
    const log = [event({ id: 'c-1', source: 'schwab_fill', schwabOrderId: '1007074485891' })]
    assert.throws(
      () => planCloseEdit(log, [patch('c-1', 1, 'debit')]),
      /Schwab fill \(order 1007074485891\)/,
    )
  })

  it('refuses a duplicated id rather than applying the last one', () => {
    assert.throws(
      () => planCloseEdit(LOG, [patch('c-sp', 1, 'debit'), patch('c-sp', 2, 'debit')]),
      /appears twice/,
    )
  })

  it('refuses the whole edit when any one patch is ineligible', () => {
    // The valid patch must not be applied "as far as it got".
    assert.throws(
      () => planCloseEdit(LOG, [patch('c-sp', 3.31, 'debit'), patch('e-lp', 9, 'debit')]),
      /only close legs are editable/,
    )
  })
})

describe('previewCloseEditTotals', () => {
  it('reproduces the SPY 8/14 repaired totals', () => {
    // Entry: 950 credit / 395 debit. The repair set SP 3.31 db, SC 0.91 db,
    // LC 0.06 cr; LP 1.56 cr was already correct. Expect 1112.00 / 817.00.
    const totals = previewCloseEditTotals(LOG, [
      patch('c-sp', 3.31, 'debit'),
      patch('c-sc', 0.91, 'debit'),
      patch('c-lc', 0.06, 'credit'),
    ])
    assert.deepEqual(totals, { credit: 1112, debit: 817 })
  })

  it('leaves untouched events at their stored amounts', () => {
    assert.deepEqual(previewCloseEditTotals(LOG, []), { credit: 1106, debit: 395 })
  })

  it('propagates a refusal instead of previewing a partial edit', () => {
    assert.throws(() => previewCloseEditTotals(LOG, [patch('e-sp', 1, 'credit')]), /only close legs/)
  })
})
