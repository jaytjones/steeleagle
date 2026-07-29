/**
 * v2.2.1 — Close-form hardening, at the schema boundary.
 *
 * The Session 15 corruption: the form sent `Number('') === 0` for three blank
 * price fields and the schema accepted three real $0.00 close events. These
 * tests pin the two rules that close it — every price EXPLICITLY entered
 * ($0.00 legal, blank refused), and all four legs present exactly once.
 *
 * Run with:  npx tsx --test lib/journal/close-schema.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CloseTradeSchema,
  EditClosedTradeSchema,
  type CloseDraftLeg,
  type Leg,
} from './types'

const AT = '2026-07-25T15:00:00.000Z'
const EXP = '2026-08-14'

const STRIKES: Record<Leg, number> = {
  long_put: 700,
  short_put: 720,
  short_call: 770,
  long_call: 790,
}

function leg(name: Leg, price: number | null): CloseDraftLeg {
  return {
    eventType: 'close',
    leg: name,
    strike: STRIKES[name],
    expiration: EXP,
    delta: null,
    price,
    creditDebit: name.startsWith('short') ? 'debit' : 'credit',
  }
}

/** The four legs of a good close, prices as the operator typed them. */
function draft(prices: [number | null, number | null, number | null, number | null]) {
  return {
    occurredAt: AT,
    closeReason: '21_dte' as const,
    events: [
      leg('long_put', prices[0]),
      leg('short_put', prices[1]),
      leg('short_call', prices[2]),
      leg('long_call', prices[3]),
    ],
  }
}

function messages(raw: unknown): string[] {
  const r = CloseTradeSchema.safeParse(raw)
  assert.equal(r.success, false, 'expected the schema to refuse this close')
  return r.error.issues.map((i) => i.message)
}

describe('CloseTradeSchema — explicit prices', () => {
  it('accepts a fully priced four-leg close', () => {
    const r = CloseTradeSchema.safeParse(draft([1.56, 3.31, 0.91, 0.06]))
    assert.equal(r.success, true)
  })

  it('accepts $0.00 — a worthless long legitimately closes at zero', () => {
    const r = CloseTradeSchema.safeParse(draft([0, 3.31, 0.91, 0]))
    assert.equal(r.success, true)
    assert.equal(r.data.events[0].price, 0)
  })

  // The exact Session 15 shape: one price entered, three fields left blank.
  it('REFUSES the blank-price close that corrupted SPY 8/14', () => {
    const msgs = messages(draft([1.56, null, null, null]))
    assert.equal(msgs.length, 3)
    assert.ok(msgs.every((m) => /\$0\.00 is allowed, blank is not/.test(m)))
  })

  it('refuses undefined and NaN the same way as null', () => {
    for (const bad of [undefined, NaN]) {
      const d = draft([1.5, 1.5, 1.5, 1.5])
      d.events[2] = { ...d.events[2], price: bad as unknown as number }
      assert.ok(messages(d).some((m) => /blank is not/.test(m)))
    }
  })

  it('still refuses a negative price', () => {
    assert.ok(messages(draft([1.5, -1, 1.5, 1.5])).some((m) => /zero or positive/.test(m)))
  })

  it('refuses a blank strike', () => {
    const d = draft([1.5, 1.5, 1.5, 1.5])
    d.events[1] = { ...d.events[1], strike: null }
    assert.ok(messages(d).some((m) => /Enter a strike for every leg/.test(m)))
  })
})

describe('CloseTradeSchema — four legs, each exactly once', () => {
  it('refuses a zero-leg close (the old expired-worthless shortcut)', () => {
    const msgs = messages({ occurredAt: AT, closeReason: 'expired', events: [] })
    assert.ok(msgs.some((m) => /all four condor legs/.test(m)))
  })

  it('refuses a zero-leg close even when the reason is expired', () => {
    // v2.2.1 decision: an expiry is journaled as four $0.00 legs, so the rule
    // is unconditional — closeReason buys no latitude.
    const msgs = messages({ occurredAt: AT, closeReason: 'expired', events: [] })
    assert.ok(msgs.length > 0)
  })

  it('accepts an expiry recorded as four $0.00 legs', () => {
    const r = CloseTradeSchema.safeParse({
      ...draft([0, 0, 0, 0]),
      closeReason: 'expired',
    })
    assert.equal(r.success, true)
  })

  it('refuses a partial-leg close', () => {
    const d = draft([1.5, 1.5, 1.5, 1.5])
    assert.ok(
      messages({ ...d, events: d.events.slice(0, 2) }).some((m) => /all four condor legs/.test(m)),
    )
  })

  it('refuses a duplicated leg role', () => {
    const d = draft([1.5, 1.5, 1.5, 1.5])
    d.events[3] = leg('short_call', 1.5)
    assert.ok(messages(d).some((m) => /Duplicate short_call leg/.test(m)))
  })

  it('refuses more than four legs', () => {
    const d = draft([1.5, 1.5, 1.5, 1.5])
    assert.ok(
      messages({ ...d, events: [...d.events, leg('short_put', 1)] }).some((m) =>
        /all four condor legs/.test(m),
      ),
    )
  })
})

describe('EditClosedTradeSchema', () => {
  const id = '3f1a9c2e-4b7d-4e21-9a5c-8d6f0b1e2c34'
  const base = {
    closedAt: AT,
    closeReason: 'profit_target' as const,
    notes: null,
    events: [{ id, price: 3.31, creditDebit: 'debit' as const, occurredAt: AT }],
  }

  it('accepts a well-formed repair', () => {
    assert.equal(EditClosedTradeSchema.safeParse(base).success, true)
  })

  it('accepts a trade-level-only edit (no leg patches)', () => {
    assert.equal(EditClosedTradeSchema.safeParse({ ...base, events: [] }).success, true)
  })

  it('accepts an explicit $0.00 but refuses a blank price', () => {
    assert.equal(
      EditClosedTradeSchema.safeParse({ ...base, events: [{ ...base.events[0], price: 0 }] })
        .success,
      true,
    )
    const r = EditClosedTradeSchema.safeParse({
      ...base,
      events: [{ ...base.events[0], price: null }],
    })
    assert.equal(r.success, false)
    assert.ok(r.error.issues.some((i) => /blank is not/.test(i.message)))
  })

  it('refuses a malformed event id', () => {
    const r = EditClosedTradeSchema.safeParse({
      ...base,
      events: [{ ...base.events[0], id: 'not-a-uuid' }],
    })
    assert.equal(r.success, false)
    assert.ok(r.error.issues.some((i) => /Malformed event id/.test(i.message)))
  })

  it('allows notes to be cleared', () => {
    const r = EditClosedTradeSchema.safeParse({ ...base, notes: null })
    assert.equal(r.success, true)
    assert.equal(r.data.notes, null)
  })
})
