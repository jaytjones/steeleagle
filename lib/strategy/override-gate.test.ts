/**
 * v2.5 — operator override on ALL verdicts.
 *
 * Pins the one predicate the UI and the journal both read. Before v2.5 the
 * placement panel rendered on PASS cards only, so FAIL and CALIBRATING had no
 * override path; these tests pin that they now do, and that what gets stamped
 * into the journal is exactly what the operator was shown.
 *
 * Run with:  npx tsx --test lib/strategy/override-gate.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ivRankDisplay,
  overrideRequirement,
  MIN_IV_HISTORY_DAYS,
} from './override-gate'

const IV_FAIL = 'IV Rank 14% is below the 25% threshold'
const LIQ_FAIL = 'Bid/ask spread is 31% of credit, above the 25% maximum'
const CALIBRATING = 'Calibrating — 3/20 days of IV history'
const CAP = 'Position limit: 5 open positions'

describe('overrideRequirement — verdict classification', () => {
  it('PASS needs no override', () => {
    const r = overrideRequirement({
      passesFilter: true,
      filterReasons: [],
      daysOfHistory: 43,
      entryGate: { status: 'OK', reasons: [] },
    })
    assert.equal(r.verdict, 'PASS')
    assert.equal(r.required, false)
    assert.deepEqual(r.violations, [])
    assert.equal(r.dataMissing, false)
  })

  it('a real FAIL (enough history, filters lost) requires an override', () => {
    const r = overrideRequirement({
      passesFilter: false,
      filterReasons: [IV_FAIL, LIQ_FAIL],
      daysOfHistory: 43,
      entryGate: { status: 'OK', reasons: [] },
    })
    assert.equal(r.verdict, 'FAIL')
    assert.equal(r.required, true)
    assert.deepEqual(r.violations, [IV_FAIL, LIQ_FAIL])
    assert.equal(r.dataMissing, false)
  })

  it('CALIBRATING is a distinct verdict, flagged as MISSING data not failed data', () => {
    const r = overrideRequirement({
      passesFilter: false,
      filterReasons: [CALIBRATING],
      daysOfHistory: 3,
      entryGate: { status: 'OK', reasons: [] },
    })
    assert.equal(r.verdict, 'CALIBRATING')
    assert.equal(r.required, true)
    assert.equal(r.dataMissing, true)
  })

  it('the CALIBRATING/FAIL boundary sits exactly at MIN_IV_HISTORY_DAYS', () => {
    const at = (daysOfHistory: number) =>
      overrideRequirement({
        passesFilter: false,
        filterReasons: [IV_FAIL],
        daysOfHistory,
        entryGate: null,
      }).verdict

    assert.equal(at(MIN_IV_HISTORY_DAYS - 1), 'CALIBRATING')
    assert.equal(at(MIN_IV_HISTORY_DAYS), 'FAIL')
  })
})

describe('overrideRequirement — entry gate interaction', () => {
  /**
   * The pre-v2.5 behavior, preserved: a PASS card whose position/BPR gate is
   * BLOCKED still requires the typed reason. This is the ONLY case the v2.1
   * override ever covered, and it must keep working unchanged.
   */
  it('PASS + BLOCKED gate still requires an override (the v2.1 case)', () => {
    const r = overrideRequirement({
      passesFilter: true,
      filterReasons: [],
      daysOfHistory: 43,
      entryGate: { status: 'BLOCKED', reasons: [CAP] },
    })
    assert.equal(r.verdict, 'PASS')
    assert.equal(r.required, true)
    assert.deepEqual(r.violations, [CAP])
  })

  it('TIGHT is a caution, not a block — it never forces the override flow', () => {
    const r = overrideRequirement({
      passesFilter: true,
      filterReasons: [],
      daysOfHistory: 43,
      entryGate: { status: 'TIGHT', reasons: ['Would use 88% of the BPR cap'] },
    })
    assert.equal(r.required, false)
    assert.deepEqual(r.violations, [])
  })

  /**
   * The case that could not exist before v2.5: a FAIL card that is ALSO at the
   * position cap. Both sets of reasons must reach the journal — overriding the
   * strategy filter does not make the capital constraint disappear.
   */
  it('FAIL + BLOCKED stamps BOTH the filter reasons and the gate reasons, filters first', () => {
    const r = overrideRequirement({
      passesFilter: false,
      filterReasons: [IV_FAIL, LIQ_FAIL],
      daysOfHistory: 43,
      entryGate: { status: 'BLOCKED', reasons: [CAP] },
    })
    assert.equal(r.required, true)
    assert.deepEqual(r.violations, [IV_FAIL, LIQ_FAIL, CAP])
  })

  it('gate reasons are NOT stamped when the gate is not blocking', () => {
    const r = overrideRequirement({
      passesFilter: false,
      filterReasons: [IV_FAIL],
      daysOfHistory: 43,
      entryGate: { status: 'TIGHT', reasons: ['Would use 88% of the BPR cap'] },
    })
    // TIGHT is surfaced on the card, but it is not something being overridden.
    assert.deepEqual(r.violations, [IV_FAIL])
  })

  it('tolerates a missing entry gate (card with no setup)', () => {
    const r = overrideRequirement({
      passesFilter: false,
      filterReasons: [IV_FAIL],
      daysOfHistory: 43,
      entryGate: null,
    })
    assert.equal(r.required, true)
    assert.deepEqual(r.violations, [IV_FAIL])
  })

  it('never records an override with an empty violation list', () => {
    // Defensive: required with nothing to show would journal "override" with
    // nothing overridden. Say so instead of stamping silence.
    const r = overrideRequirement({
      passesFilter: false,
      filterReasons: [],
      daysOfHistory: 43,
      entryGate: null,
    })
    assert.equal(r.required, true)
    assert.equal(r.violations.length, 1)
    assert.match(r.violations[0], /no specific reason reported/)
  })
})

describe('ivRankDisplay', () => {
  it('reports UNKNOWN with the day count while calibrating', () => {
    assert.deepEqual(ivRankDisplay({ ivRank: 0, daysOfHistory: 3 }), {
      kind: 'unknown',
      days: 3,
    })
  })

  /**
   * calculateIVRank returns ivRank: 0 as a PLACEHOLDER while calibrating. That
   * zero must never reach the card as "0.0%" — it is not a measurement, and a
   * number on screen is a number April can act on.
   */
  it('does not surface the placeholder 0 as a real rank', () => {
    const d = ivRankDisplay({ ivRank: 0, daysOfHistory: 19 })
    assert.equal(d.kind, 'unknown')
  })

  it('reports the value once there is enough history', () => {
    assert.deepEqual(ivRankDisplay({ ivRank: 31.4, daysOfHistory: 20 }), {
      kind: 'value',
      pct: 31.4,
    })
  })

  it('a genuine 0.0% rank with full history IS a value, not unknown', () => {
    assert.deepEqual(ivRankDisplay({ ivRank: 0, daysOfHistory: 43 }), {
      kind: 'value',
      pct: 0,
    })
  })
})
