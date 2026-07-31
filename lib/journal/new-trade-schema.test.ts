/**
 * v2.3.2 — New Trade (entry) hardening, at the schema boundary.
 *
 * The third and last journal write path to carry the F25 defect class. The
 * entry form sent `Number('') === 0` for a blank price, strike, or BPR, and
 * NewTradeSchema's `positiveMoney` accepted the zero.
 *
 * This path is the highest-stakes of the three: a $0.00 entry leg corrupts
 * initialCredit -> netCredit -> profitTargetBuyback, and THAT is the price the
 * exit sweep places the standing 50% GTC at. A blank here mis-prices a live
 * working order at Schwab, where the close-side corruption only mangled history.
 *
 * Run with:  npx tsx --test lib/journal/new-trade-schema.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NewTradeSchema, type Leg, type NewTradeDraft, type NewTradeLegDraft } from './types'

const AT = '2026-07-31T14:30:00.000Z'
const EXP = '2026-09-18'

const STRIKES: Record<Leg, number> = {
  long_put: 700,
  short_put: 720,
  short_call: 770,
  long_call: 790,
}

function leg(name: Leg, price: number | null): NewTradeLegDraft {
  return {
    leg: name,
    strike: STRIKES[name],
    expiration: EXP,
    delta: null,
    price,
    // Standard short condor: sell the inner strikes, buy the wings.
    creditDebit: name.startsWith('short') ? 'credit' : 'debit',
  }
}

function draft(
  prices: [number | null, number | null, number | null, number | null] = [0.9, 3.4, 3.1, 0.8],
  overrides: Partial<NewTradeDraft> = {},
): NewTradeDraft {
  return {
    symbol: 'SPY',
    sleeve: 'core',
    openedAt: AT,
    initialExpiration: EXP,
    contracts: 1,
    initialBpr: 1800,
    legs: [
      leg('long_put', prices[0]),
      leg('short_put', prices[1]),
      leg('short_call', prices[2]),
      leg('long_call', prices[3]),
    ],
    ...overrides,
  }
}

function messages(raw: unknown): string[] {
  const r = NewTradeSchema.safeParse(raw)
  assert.equal(r.success, false, 'expected the schema to refuse this entry')
  return r.error.issues.map((i) => i.message)
}

describe('NewTradeSchema — explicit leg prices', () => {
  it('accepts a fully priced four-leg entry', () => {
    assert.equal(NewTradeSchema.safeParse(draft()).success, true)
  })

  it('REFUSES a blank price on any leg', () => {
    assert.ok(
      messages(draft([0.9, null, 3.1, 0.8])).some((m) =>
        /\$0\.00 is allowed, blank is not/.test(m),
      ),
    )
  })

  it('refuses undefined and NaN the same way as null', () => {
    for (const bad of [undefined, NaN]) {
      const d = draft()
      d.legs[0] = { ...d.legs[0], price: bad as unknown as number }
      assert.ok(messages(d).some((m) => /blank is not/.test(m)))
    }
  })

  it('refuses a blank strike, and a zero strike from the old coercion', () => {
    const blank = draft()
    blank.legs[2] = { ...blank.legs[2], strike: null }
    assert.ok(messages(blank).some((m) => /Enter a strike for every leg/.test(m)))

    const zero = draft()
    zero.legs[2] = { ...zero.legs[2], strike: 0 }
    assert.ok(messages(zero).some((m) => /Strike must be positive/.test(m)))
  })

  it('still accepts an explicit $0.00 leg price', () => {
    // Unusual on entry but not impossible, and the rule is about ABSENCE.
    assert.equal(NewTradeSchema.safeParse(draft([0, 3.4, 3.1, 0.8])).success, true)
  })

  it('still requires exactly four legs', () => {
    const d = draft()
    assert.ok(
      messages({ ...d, legs: d.legs.slice(0, 3) }).some((m) => /exactly 4 legs/.test(m)),
    )
  })
})

describe('NewTradeSchema — BPR must be entered AND positive', () => {
  /**
   * The deliberate asymmetry with price: $0.00 is a legitimate price, but a
   * four-leg condor always reduces buying power, so 0 only ever means "not
   * filled in". recordFillAction already floored it at $0.01, and
   * ImportCandidate.initialBpr documents its 0 default as a placeholder.
   */
  it('refuses a blank BPR', () => {
    assert.ok(
      messages(draft(undefined, { initialBpr: null })).some((m) =>
        /Enter the buying-power reduction/.test(m),
      ),
    )
  })

  it('refuses a ZERO BPR — 0 means unset, not free capital', () => {
    assert.ok(
      messages(draft(undefined, { initialBpr: 0 })).some((m) =>
        /BPR must be greater than zero/.test(m),
      ),
    )
  })

  it('accepts the $0.01 floor the at-fill path produces', () => {
    assert.equal(NewTradeSchema.safeParse(draft(undefined, { initialBpr: 0.01 })).success, true)
  })

  it('refuses a negative BPR', () => {
    assert.ok(
      messages(draft(undefined, { initialBpr: -100 })).some((m) =>
        /greater than zero/.test(m),
      ),
    )
  })
})

describe('NewTradeSchema — contracts', () => {
  it('refuses a blank contract count', () => {
    assert.ok(
      messages(draft(undefined, { contracts: null })).some((m) =>
        /Enter the number of contracts/.test(m),
      ),
    )
  })

  it('refuses zero and fractional contracts', () => {
    assert.ok(
      messages(draft(undefined, { contracts: 0 })).some((m) => /at least 1/.test(m)),
    )
    assert.ok(
      messages(draft(undefined, { contracts: 1.5 })).some((m) => /whole number/.test(m)),
    )
  })

  it('defaults to 1 when the key is absent entirely', () => {
    // The importer and at-fill path always supply it; the default is for
    // callers that legitimately omit the key, not for a blank field.
    const d = draft()
    const { contracts: _omitted, ...withoutContracts } = d
    const r = NewTradeSchema.safeParse(withoutContracts)
    assert.equal(r.success, true)
    assert.equal(r.data.contracts, 1)
  })
})
