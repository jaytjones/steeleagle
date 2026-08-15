import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { classifyFill } from './classify-fill'
import { GOLDEN_FILLS } from './golden-fills.fixture'
import { creditDebitFor, fillToPrefill, instructionFor } from './fill-to-draft'
import { RollTradeSchema, CloseTradeSchema } from './types'
import type { SchwabOrderDetail } from '../schwab/orders'

const { GLD_ENTRY, SPY_BUTTERFLY_CLOSE, SPY_ROLL_CUSTOM, SPY_SPLIT_CLOSE } = GOLDEN_FILLS

describe('instructionFor — the F3 table, inverted', () => {
  it('closing a SHORT is a buy-back', () => {
    assert.equal(instructionFor('close', 'short_put'), 'BUY_TO_CLOSE')
    assert.equal(instructionFor('close', 'short_call'), 'BUY_TO_CLOSE')
  })

  it('closing a LONG is a sale', () => {
    assert.equal(instructionFor('close', 'long_put'), 'SELL_TO_CLOSE')
    assert.equal(instructionFor('close', 'long_call'), 'SELL_TO_CLOSE')
  })

  it('opening a SHORT collects premium', () => {
    assert.equal(instructionFor('open', 'short_put'), 'SELL_TO_OPEN')
  })

  it('opening a LONG pays for the wing', () => {
    assert.equal(instructionFor('open', 'long_put'), 'BUY_TO_OPEN')
  })

  it('round-trips against classify-fill for every fixture leg', () => {
    // The two tables must agree in both directions or a pre-filled leg would
    // invert relative to how the same fill was classified.
    for (const order of Object.values(GOLDEN_FILLS)) {
      for (const leg of classifyFill(order).legs) {
        const instruction = instructionFor(leg.action, leg.role)
        assert.equal(
          instruction.endsWith('_CLOSE'),
          leg.action === 'close',
          `${leg.occSymbol} action`,
        )
      }
    }
  })
})

describe('creditDebitFor — buying pays, selling collects', () => {
  it('is a debit for both BUY instructions', () => {
    assert.equal(creditDebitFor('close', 'short_put'), 'debit') // BUY_TO_CLOSE
    assert.equal(creditDebitFor('open', 'long_put'), 'debit') // BUY_TO_OPEN
  })

  it('is a credit for both SELL instructions', () => {
    assert.equal(creditDebitFor('close', 'long_put'), 'credit') // SELL_TO_CLOSE
    assert.equal(creditDebitFor('open', 'short_put'), 'credit') // SELL_TO_OPEN
  })
})

describe('fillToPrefill — the Aug 5 roll (order 1007483420023)', () => {
  const p = fillToPrefill(classifyFill(SPY_ROLL_CUSTOM))!

  it('opens the ROLL form', () => {
    assert.equal(p.mode, 'roll')
    assert.equal(p.occurredAt, '2026-08-05T17:56:00.000Z')
  })

  it('orders closes before opens — what left, then what replaced it', () => {
    assert.deepEqual(p.rows.map((r) => r.eventType), [
      'roll_close',
      'roll_close',
      'roll_open',
      'roll_open',
    ])
  })

  it('carries the real fill prices and the right direction on every leg', () => {
    assert.deepEqual(
      p.rows.map((r) => [r.eventType, r.leg, r.strike, r.price, r.creditDebit]),
      [
        ['roll_close', 'short_put', '740', '4.26', 'debit'], // BUY_TO_CLOSE
        ['roll_close', 'long_put', '725', '2.80', 'credit'], // SELL_TO_CLOSE
        ['roll_open', 'short_put', '750', '5.77', 'credit'], // SELL_TO_OPEN
        ['roll_open', 'long_put', '735', '3.69', 'debit'], // BUY_TO_OPEN
      ],
    )
  })

  it('nets to the ticket price Schwab recorded — the arithmetic cross-check', () => {
    const net = p.rows.reduce(
      (sum, r) => sum + (r.creditDebit === 'credit' ? Number(r.price) : -Number(r.price)),
      0,
    )
    assert.equal(Math.round(net * 100) / 100, 0.62) // Schwab: NET_CREDIT 0.62
  })

  it('leaves delta blank — Schwab order payloads carry no greeks', () => {
    assert.ok(p.rows.every((r) => r.delta === ''))
  })

  it('records its provenance in the notes', () => {
    assert.match(p.notes, /Schwab order 1007483420023/)
  })

  it('PASSES RollTradeSchema as-is — a pre-fill that cannot submit is useless', () => {
    const draft = {
      occurredAt: p.occurredAt,
      newExpiration: null,
      notes: p.notes,
      events: p.rows.map((r) => ({
        eventType: r.eventType!,
        leg: r.leg,
        strike: Number(r.strike),
        expiration: r.expiration,
        delta: null,
        price: Number(r.price),
        creditDebit: r.creditDebit,
      })),
    }
    const parsed = RollTradeSchema.safeParse(draft)
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  })
})

describe('fillToPrefill — the SPY butterfly close (order 1007514529392)', () => {
  const p = fillToPrefill(classifyFill(SPY_BUTTERFLY_CLOSE))!

  it('opens the CLOSE form with all four legs', () => {
    assert.equal(p.mode, 'close')
    assert.equal(p.rows.length, 4)
    assert.ok(p.rows.every((r) => r.eventType === undefined), 'close rows carry no event type')
  })

  it('buy-backs are debits, sales are credits', () => {
    assert.deepEqual(
      p.rows.map((r) => [r.leg, r.strike, r.price, r.creditDebit]),
      [
        ['short_call', '765', '14.38', 'debit'],
        ['long_call', '785', '4.03', 'credit'],
        ['short_put', '765', '5.83', 'debit'],
        ['long_put', '745', '2.18', 'credit'],
      ],
    )
  })

  it('nets to the $14.00 debit Schwab recorded', () => {
    const net = p.rows.reduce(
      (sum, r) => sum + (r.creditDebit === 'credit' ? Number(r.price) : -Number(r.price)),
      0,
    )
    assert.equal(Math.round(net * 100) / 100, -14)
  })

  it('PASSES CloseTradeSchema as-is', () => {
    const parsed = CloseTradeSchema.safeParse({
      occurredAt: p.occurredAt,
      closeReason: 'manual',
      notes: p.notes,
      events: p.rows.map((r) => ({
        eventType: 'close' as const,
        leg: r.leg,
        strike: Number(r.strike),
        expiration: r.expiration,
        delta: null,
        price: Number(r.price),
        creditDebit: r.creditDebit,
      })),
    })
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  })
})

describe('fillToPrefill — never fabricates a price', () => {
  // $0.00 is a LEGITIMATE fill price for a worthless long, so a fabricated zero
  // would be indistinguishable from a real one — and it would mis-price the
  // standing GTC the sweep builds from the journal. This is the Session 15
  // corruption in a new costume.
  // A PARTIAL execution: legs 1 and 2 filled, legs 3 and 4 did not. This is the
  // shape that actually reaches the pre-fill — a wholly unexecuted order returns
  // null now (see the block below), so a partial is the only way a real fill
  // arrives carrying a leg with no price.
  const noPrices: SchwabOrderDetail = {
    ...SPY_ROLL_CUSTOM,
    status: 'PARTIALLY_FILLED',
    filledQuantity: 1,
    orderActivityCollection: [
      {
        executionLegs: [
          { legId: 1, quantity: 1, price: 5.77, time: '2026-08-05T17:56:00+0000' },
          { legId: 2, quantity: 1, price: 4.26, time: '2026-08-05T17:56:00+0000' },
        ],
      },
    ],
  }

  it('emits the EMPTY STRING, never "0.00", for a leg with no execution', () => {
    const p = fillToPrefill(classifyFill(noPrices))!
    const unexecuted = p.rows.filter((r) => r.price === '')
    assert.equal(unexecuted.length, 2, 'the two legs that never filled')
    assert.ok(!p.rows.some((r) => r.price === '0.00'), 'never a fabricated zero')
    assert.equal(p.hasMissingPrices, true)
  })

  it('a blank price FAILS the schema — the operator must supply it', () => {
    const p = fillToPrefill(classifyFill(noPrices))!
    const parsed = RollTradeSchema.safeParse({
      occurredAt: p.occurredAt,
      newExpiration: null,
      events: p.rows.map((r) => ({
        eventType: r.eventType!,
        leg: r.leg,
        strike: Number(r.strike),
        expiration: r.expiration,
        delta: null,
        price: r.price === '' ? null : Number(r.price), // what numOrNull does
        creditDebit: r.creditDebit,
      })),
    })
    assert.equal(parsed.success, false, 'the v2.3.1 hardening still bites')
  })

  it('flags hasMissingPrices false when every leg filled', () => {
    assert.equal(fillToPrefill(classifyFill(SPY_ROLL_CUSTOM))!.hasMissingPrices, false)
  })
})

describe('fillToPrefill — what it refuses to offer', () => {
  it('an ENTRY returns null — initialBpr is not in the order payload', () => {
    // `enteredBpr` refuses 0 by design, so a pre-filled entry form could never
    // be submitted. Import from Schwab asks for BPR on its review card.
    assert.equal(fillToPrefill(classifyFill(GLD_ENTRY)), null)
  })

  it('a split-roll half opens the roll form but SAYS it is incomplete', () => {
    const p = fillToPrefill(classifyFill(SPY_SPLIT_CLOSE))!
    assert.equal(p.mode, 'roll')
    assert.equal(p.rows.length, 2)
    assert.match(p.notes, /SPLIT roll/)
    assert.match(p.notes, /Add the partner ticket/)
  })

  it('a split-roll half FAILS the schema until its partner is added', () => {
    // RollTradeSchema refuses a roll_open with no matching roll_close on the
    // same role. The two roll_close rows alone are legal (a one-sided unwind),
    // so the note is what tells the operator to add the rest.
    const p = fillToPrefill(classifyFill(GOLDEN_FILLS.SPY_SPLIT_OPEN))!
    const parsed = RollTradeSchema.safeParse({
      occurredAt: p.occurredAt,
      newExpiration: null,
      events: p.rows.map((r) => ({
        eventType: r.eventType!,
        leg: r.leg,
        strike: Number(r.strike),
        expiration: r.expiration,
        delta: null,
        price: Number(r.price),
        creditDebit: r.creditDebit,
      })),
    })
    assert.equal(parsed.success, false)
  })

  it('an AMBIGUOUS fill offers no form at all', () => {
    const bad = { ...classifyFill(SPY_ROLL_CUSTOM), shape: 'AMBIGUOUS' as const }
    assert.equal(fillToPrefill(bad), null)
  })
})

describe('fillToPrefill — nothing executed means nothing to journal', () => {
  // Live check 2026-08-14: the five GLD rejections were each offering
  // "Journal this close" with four blank prices — inviting the operator to
  // journal an event that never happened.
  const rejected = (over: Partial<SchwabOrderDetail> = {}): SchwabOrderDetail => ({
    ...SPY_BUTTERFLY_CLOSE,
    status: 'REJECTED',
    filledQuantity: 0,
    orderActivityCollection: [],
    ...over,
  })

  it('a REJECTED close offers NO form', () => {
    assert.equal(fillToPrefill(classifyFill(rejected())), null)
  })

  it('a WORKING GTC offers NO form', () => {
    assert.equal(fillToPrefill(classifyFill(rejected({ status: 'WORKING' }))), null)
  })

  it('a REPLACED order with zero-value executions offers NO form', () => {
    const dead = rejected({
      status: 'REPLACED',
      orderActivityCollection: [{ executionLegs: [{ legId: 1, price: 0 }] }],
    })
    assert.equal(fillToPrefill(classifyFill(dead)), null)
  })

  it('a genuinely FILLED order still offers its form', () => {
    assert.ok(fillToPrefill(classifyFill(SPY_BUTTERFLY_CLOSE)) !== null)
  })
})
