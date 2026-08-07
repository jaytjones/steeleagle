/**
 * Run with:  npx tsx --test lib/strategy/expiration.test.ts
 *
 * v2.10 expiration selection. The anchor is the REAL 2026-08-07 chain, probed
 * live from Schwab for SPY and GLD:
 *
 *   2026-09-04  28 DTE  W    <- what the scanner WAS proposing (below the floor)
 *   2026-09-11  35 DTE  W
 *   2026-09-18  42 DTE  S    <- monthly; the correct pick
 *   2026-09-25  49 DTE  W
 *
 * The load-bearing test in this file is the LAST suite: the IV ordering must
 * keep picking 28 DTE while the condor ordering picks 42. If those two ever
 * agree by construction, `IV_BASIS_CURRENT` has silently changed meaning and
 * every symbol's 52-week range is quietly comparing two different tenors.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  orderIvCandidates,
  orderCondorCandidates,
  isMonthlyExpirationType,
  noCondorReason,
  CONDOR_DTE_MIN,
  CONDOR_DTE_MAX,
  CONDOR_DTE_TARGET,
  type ExpirationCandidate,
} from './expiration'

function exp(date: string, dte: number, isMonthly = false): ExpirationCandidate {
  return { key: `${date}:${dte}`, date, dte, isMonthly }
}

/** The live 2026-08-07 SPY/GLD chain. */
const LIVE_2026_08_07: ExpirationCandidate[] = [
  exp('2026-09-04', 28),
  exp('2026-09-11', 35),
  exp('2026-09-18', 42, true),
  exp('2026-09-25', 49),
]

// --------------------------------------------------------
describe('isMonthlyExpirationType — probe-pinned, NOT guessed', () => {
  // The whole point: Schwab says "S", not "M". A preference keyed on "M" would
  // never fire and would look exactly like "no monthly available".
  it('"S" is the monthly (standard) expiration', () => {
    assert.equal(isMonthlyExpirationType('S'), true)
  })

  it('"W" (weekly) is not', () => {
    assert.equal(isMonthlyExpirationType('W'), false)
  })

  it('"M" is NOT the monthly — this is the doc trap', () => {
    assert.equal(isMonthlyExpirationType('M'), false)
  })

  it('quarterly "Q" is not treated as the monthly', () => {
    assert.equal(isMonthlyExpirationType('Q'), false)
  })

  it('missing/null expirationType is not monthly', () => {
    assert.equal(isMonthlyExpirationType(undefined), false)
    assert.equal(isMonthlyExpirationType(null), false)
    assert.equal(isMonthlyExpirationType(''), false)
  })
})

// --------------------------------------------------------
describe('orderCondorCandidates — the 2026-08-07 live chain', () => {
  it('picks the 42-DTE MONTHLY, not the 28-DTE weekly', () => {
    const picked = orderCondorCandidates(LIVE_2026_08_07)[0]
    assert.equal(picked.date, '2026-09-18')
    assert.equal(picked.dte, 42)
    assert.equal(picked.isMonthly, true)
  })

  it('excludes 28 DTE — below the 30-day floor', () => {
    const dtes = orderCondorCandidates(LIVE_2026_08_07).map((e) => e.dte)
    assert.ok(!dtes.includes(28), 'the old pick must no longer be eligible')
  })

  it('excludes 49 DTE — above the 45-day ceiling', () => {
    const dtes = orderCondorCandidates(LIVE_2026_08_07).map((e) => e.dte)
    assert.ok(!dtes.includes(49))
  })

  it('keeps exactly the two in-window expirations', () => {
    assert.deepEqual(
      orderCondorCandidates(LIVE_2026_08_07).map((e) => e.dte),
      [42, 35],
    )
  })
})

// --------------------------------------------------------
describe('orderCondorCandidates — monthly always wins in range', () => {
  // April's rule, chosen over a tolerance band: simple and predictable.
  it('a 31-DTE monthly beats a 44-DTE weekly despite being further from 37.5', () => {
    const picked = orderCondorCandidates([exp('a', 44), exp('b', 31, true)])[0]
    assert.equal(picked.dte, 31)
    assert.equal(picked.isMonthly, true)
  })

  it('a 45-DTE monthly beats a 37-DTE weekly sitting on the target', () => {
    const picked = orderCondorCandidates([exp('a', 37), exp('b', 45, true)])[0]
    assert.equal(picked.dte, 45)
  })

  // But the window still binds: a monthly OUTSIDE 30-45 is not resurrected.
  it('a 28-DTE monthly is still excluded — the window beats the preference', () => {
    const ordered = orderCondorCandidates([exp('a', 28, true), exp('b', 35)])
    assert.equal(ordered.length, 1)
    assert.equal(ordered[0].dte, 35)
  })

  it('a 46-DTE monthly is excluded too', () => {
    const ordered = orderCondorCandidates([exp('a', 46, true), exp('b', 33)])
    assert.deepEqual(ordered.map((e) => e.dte), [33])
  })

  it('with two monthlies in range, the closer to target wins', () => {
    const picked = orderCondorCandidates([exp('a', 31, true), exp('b', 39, true)])[0]
    assert.equal(picked.dte, 39)
  })
})

// --------------------------------------------------------
describe('orderCondorCandidates — no monthly: closest to the 37.5 midpoint', () => {
  it('picks 38 over 32 and 44', () => {
    const picked = orderCondorCandidates([exp('a', 32), exp('b', 38), exp('c', 44)])[0]
    assert.equal(picked.dte, 38)
  })

  it('picks 37 over 30 and 45 (the window edges)', () => {
    const picked = orderCondorCandidates([exp('a', 30), exp('b', 45), exp('c', 37)])[0]
    assert.equal(picked.dte, 37)
  })

  // Determinism matters: an unstable tie would make the proposal wobble
  // between dashboard refreshes with no input having changed.
  it('an exact tie breaks LONGER — 35 vs 40 picks 40', () => {
    assert.equal(orderCondorCandidates([exp('a', 35), exp('b', 40)])[0].dte, 40)
    // and the reverse input order gives the same answer
    assert.equal(orderCondorCandidates([exp('b', 40), exp('a', 35)])[0].dte, 40)
  })

  it('the boundaries 30 and 45 are both INCLUSIVE', () => {
    assert.deepEqual(
      orderCondorCandidates([exp('a', 30), exp('b', 45)]).map((e) => e.dte).sort(),
      [30, 45],
    )
    assert.equal(orderCondorCandidates([exp('a', 29)]).length, 0)
    assert.equal(orderCondorCandidates([exp('a', 46)]).length, 0)
  })
})

// --------------------------------------------------------
describe('orderCondorCandidates — refuse rather than stretch', () => {
  it('returns empty when nothing is in window — no fallback', () => {
    assert.deepEqual(orderCondorCandidates([exp('a', 28), exp('b', 49)]), [])
  })

  it('returns empty for an empty chain', () => {
    assert.deepEqual(orderCondorCandidates([]), [])
  })

  // Roughly half the time no monthly falls in a 16-day window, so the weekly
  // path is the common case, not an edge case.
  it('a window with only weeklies still proposes', () => {
    assert.equal(orderCondorCandidates([exp('a', 33), exp('b', 41)])[0].dte, 41)
  })
})

// --------------------------------------------------------
describe('noCondorReason', () => {
  it('names the nearest available expiration when none qualifies', () => {
    const r = noCondorReason([exp('2026-09-04', 28), exp('2026-09-25', 49)])
    assert.match(r, /No expiration in the 30–45 DTE window/)
    assert.match(r, /2026-09-04 at 28 DTE/)
  })

  it('is empty when an eligible expiration DOES exist (the builder refused instead)', () => {
    assert.equal(noCondorReason(LIVE_2026_08_07), '')
  })

  it('does not crash on an empty chain', () => {
    assert.match(noCondorReason([]), /No expiration in the 30–45 DTE window/)
  })
})

// --------------------------------------------------------
// THE LOAD-BEARING SUITE.
//
// If these two orderings ever converge, the IV basis has silently changed and
// `iv_history` starts mixing tenors inside one 52-week range — the exact defect
// v2.6 existed to fix, reintroduced by a "cleanup".
// --------------------------------------------------------
describe('IV and condor selection are DECOUPLED — do not merge these', () => {
  it('on the live 2026-08-07 chain they deliberately disagree: IV 28, condor 42', () => {
    assert.equal(orderIvCandidates(LIVE_2026_08_07)[0].dte, 28)
    assert.equal(orderCondorCandidates(LIVE_2026_08_07)[0].dte, 42)
  })

  it('the IV rule still takes NEAREST within 28–52 — basis atm_28_52dte, unchanged', () => {
    assert.deepEqual(
      orderIvCandidates(LIVE_2026_08_07).map((e) => e.dte),
      [28, 35, 42, 49],
    )
  })

  it('the IV rule ignores monthliness entirely', () => {
    const picked = orderIvCandidates([exp('a', 42, true), exp('b', 29)])[0]
    assert.equal(picked.dte, 29, 'nearest wins; a monthly must NOT be preferred here')
  })

  it('the IV rule still accepts 28–29 DTE, which the condor rule excludes', () => {
    const cands = [exp('a', 28), exp('b', 29)]
    assert.equal(orderIvCandidates(cands).length, 2)
    assert.equal(orderCondorCandidates(cands).length, 0)
  })

  it('the IV rule still accepts 46–52 DTE, which the condor rule excludes', () => {
    const cands = [exp('a', 49), exp('b', 52)]
    assert.equal(orderIvCandidates(cands).length, 2)
    assert.equal(orderCondorCandidates(cands).length, 0)
  })

  // The IV path must survive a chain with NO tradeable condor expiration —
  // otherwise a symbol drops out of iv_history and punches a hole in its
  // 52-week range, which is unrecoverable (Schwab serves no historical IV).
  it('a chain with no condor expiration STILL yields an IV pick', () => {
    const cands = [exp('a', 28), exp('b', 50)]
    assert.equal(orderCondorCandidates(cands).length, 0)
    assert.equal(orderIvCandidates(cands)[0].dte, 28)
  })

  it('the windows are not accidentally identical', () => {
    assert.ok(CONDOR_DTE_MIN > 28, 'condor floor must be above the IV floor')
    assert.ok(CONDOR_DTE_MAX < 52, 'condor ceiling must be below the IV ceiling')
    assert.equal(CONDOR_DTE_TARGET, 37.5)
  })
})
