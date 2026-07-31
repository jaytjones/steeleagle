/**
 * v2.3.1 — Roll-form hardening, at the schema boundary.
 *
 * Ports the v2.2.1 close-side fix (F25) to the roll path: the roll form sent
 * `Number('') === 0` for a blank price field and RollEventSchema — which
 * inherited LegInputSchema's `nonnegative()` price — accepted it as a real
 * $0.00 roll leg. Same defect class that corrupted SPY 8/14 on the close side.
 * $0.00 is legal, blank is not.
 *
 * The second block pins the roll-leg invariant, which is NOT the close form's
 * "exactly four legs, each role once" rule. See the comment on RollTradeSchema
 * for where each rule comes from in currentStructure's fold.
 *
 * Run with:  npx tsx --test lib/journal/roll-schema.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RollTradeSchema, type Leg, type RollDraftLeg, type RollTradeDraft } from './types'

const AT = '2026-07-30T15:00:00.000Z'
const EXP = '2026-08-14'
const NEW_EXP = '2026-09-18'

const STRIKES: Record<Leg, number> = {
  long_put: 700,
  short_put: 720,
  short_call: 770,
  long_call: 790,
}

function leg(
  eventType: 'roll_close' | 'roll_open',
  name: Leg,
  price: number | null,
  strike: number | null = STRIKES[name],
): RollDraftLeg {
  return {
    eventType,
    leg: name,
    strike,
    expiration: eventType === 'roll_open' ? NEW_EXP : EXP,
    delta: null,
    // Buying back the old leg pays a debit; selling the replacement collects.
    price,
    creditDebit: eventType === 'roll_close' ? 'debit' : 'credit',
  }
}

/** The canonical one-sided roll: close the short call, reopen it further out. */
function draft(closePrice: number | null, openPrice: number | null): RollTradeDraft {
  return {
    occurredAt: AT,
    newExpiration: NEW_EXP,
    events: [
      leg('roll_close', 'short_call', closePrice),
      leg('roll_open', 'short_call', openPrice),
    ],
  }
}

function messages(raw: unknown): string[] {
  const r = RollTradeSchema.safeParse(raw)
  assert.equal(r.success, false, 'expected the schema to refuse this roll')
  return r.error.issues.map((i) => i.message)
}

describe('RollTradeSchema — explicit prices', () => {
  it('accepts a fully priced one-sided roll', () => {
    assert.equal(RollTradeSchema.safeParse(draft(2.15, 3.4)).success, true)
  })

  it('accepts $0.00 — a worthless leg is legitimately bought back at zero', () => {
    const r = RollTradeSchema.safeParse(draft(0, 3.4))
    assert.equal(r.success, true)
    assert.equal(r.data.events[0].price, 0)
  })

  // The defect this milestone exists to close: blank price reaching the DB as $0.00.
  it('REFUSES a blank price on the roll_close leg', () => {
    assert.ok(messages(draft(null, 3.4)).some((m) => /\$0\.00 is allowed, blank is not/.test(m)))
  })

  it('REFUSES a blank price on the roll_open leg', () => {
    assert.ok(messages(draft(2.15, null)).some((m) => /\$0\.00 is allowed, blank is not/.test(m)))
  })

  it('refuses undefined and NaN the same way as null', () => {
    for (const bad of [undefined, NaN]) {
      const d = draft(2.15, 3.4)
      d.events[1] = { ...d.events[1], price: bad as unknown as number }
      assert.ok(messages(d).some((m) => /blank is not/.test(m)))
    }
  })

  it('still refuses a negative price', () => {
    assert.ok(messages(draft(2.15, -1)).some((m) => /zero or positive/.test(m)))
  })

  it('refuses a blank strike with the explicit message', () => {
    const d = draft(2.15, 3.4)
    d.events[1] = { ...d.events[1], strike: null }
    assert.ok(messages(d).some((m) => /Enter a strike for every leg/.test(m)))
  })

  it('refuses a zero strike — Number("") coerced through the old path', () => {
    const d = draft(2.15, 3.4)
    d.events[1] = { ...d.events[1], strike: 0 }
    assert.ok(messages(d).some((m) => /Strike must be positive/.test(m)))
  })
})

describe('RollTradeSchema — the roll-leg invariant', () => {
  it('accepts a full 8-leg roll of both sides', () => {
    const roles: Leg[] = ['long_put', 'short_put', 'short_call', 'long_call']
    const r = RollTradeSchema.safeParse({
      occurredAt: AT,
      newExpiration: NEW_EXP,
      events: [
        ...roles.map((role) => leg('roll_close', role, 1.1)),
        ...roles.map((role) => leg('roll_open', role, 1.4)),
      ],
    })
    assert.equal(r.success, true)
  })

  it('refuses a duplicated roll_open on one role (the fold would last-win)', () => {
    const d = draft(2.15, 3.4)
    d.events.push(leg('roll_open', 'short_call', 3.5))
    assert.ok(messages(d).some((m) => /Duplicate roll_open on short_call/.test(m)))
  })

  it('refuses a duplicated roll_close on one role (the fold would throw)', () => {
    const d = draft(2.15, 3.4)
    d.events.push(leg('roll_close', 'short_call', 2.2))
    assert.ok(messages(d).some((m) => /Duplicate roll_close on short_call/.test(m)))
  })

  it('refuses a roll_open whose role is not closed in the same roll', () => {
    const d = draft(2.15, 3.4)
    d.events.push(leg('roll_open', 'long_call', 0.4))
    assert.ok(messages(d).some((m) => /without closing it in the same roll/.test(m)))
  })

  /**
   * Decided with April 2026-07-30: ALLOWED. It leaves the role vacant, which
   * currentStructure refuses loudly (→ MANUAL GTC chip, already fail-safe), and
   * it is the only way to journal a one-sided unwind — Record Close closes the
   * whole trade. Do not "tighten" this into strict pairing without reopening it.
   */
  it('ALLOWS a roll_close with no matching roll_open (one-sided unwind)', () => {
    const r = RollTradeSchema.safeParse({
      occurredAt: AT,
      newExpiration: null,
      events: [leg('roll_close', 'long_put', 0.05), leg('roll_close', 'short_put', 1.2)],
    })
    assert.equal(r.success, true)
  })

  it('still refuses fewer than 2 or more than 8 legs', () => {
    const one = { occurredAt: AT, newExpiration: null, events: [leg('roll_close', 'short_call', 1)] }
    assert.ok(messages(one).some((m) => /at least 2 legs/.test(m)))

    const roles: Leg[] = ['long_put', 'short_put', 'short_call', 'long_call']
    const nine = {
      occurredAt: AT,
      newExpiration: NEW_EXP,
      events: [
        ...roles.map((role) => leg('roll_close', role, 1.1)),
        ...roles.map((role) => leg('roll_open', role, 1.4)),
        leg('roll_open', 'short_call', 1.4),
      ],
    }
    assert.ok(messages(nine).some((m) => /at most 8 legs/.test(m)))
  })
})
