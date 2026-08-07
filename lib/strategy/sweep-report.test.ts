/**
 * Run with:  npx tsx --test lib/strategy/sweep-report.test.ts
 *
 * v2.9 sweep run visibility. The anchor is the REAL Aug 5–6 2026 incident on
 * SPY 2026-09-11: an unjournaled roll, a stale-journal GTC rejected by Schwab,
 * and a reconciliation DRIFT — all correctly detected, three runs running, and
 * none of it ever seen. These tests pin that such a run classifies CRITICAL.
 *
 * The counterweight, and the harder half: a steady-state run holding an SPX
 * condor flags a routine refusal on EVERY sweep, forever, by design. That must
 * NOT read critical, or the banner is permanently red and stops being read —
 * the same silent-state failure, inverted.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  summarizeSweepRun,
  sweepFreshness,
  expectedRunsBetween,
  MISSED_RUNS_BEFORE_STALE,
  type ExitSweepReport,
  type SweepFlag,
} from './sweep-report'

function report(over: Partial<ExitSweepReport> = {}): ExitSweepReport {
  return {
    reconciled: [],
    cleared: [],
    alerts: [],
    placed: [],
    flagged: [],
    errors: [],
    placementPaused: false,
    wouldHavePlaced: [],
    reconciliation: { ran: true, critical: 0, summary: {}, findings: [] },
    ...over,
  }
}

function flag(severity: SweepFlag['severity'], reason: string): SweepFlag {
  return { tradeId: 't1', orderId: null, reason, severity }
}

// --------------------------------------------------------
describe('summarizeSweepRun — the Aug 5–6 SPY 2026-09-11 incident', () => {
  // What the Aug 6 run actually contained.
  const incident = report({
    flagged: [
      flag(
        'critical',
        'RECONCILIATION DRIFT — SPY 2026-09-11: strikes differ — journal 725 / 740 / 775 / 790, ' +
          'account 735 / 750 / 775 / 790.',
      ),
      flag(
        'critical',
        'GTC 1007505458280 on SPY was REJECTED immediately after placement — id not stored',
      ),
    ],
    reconciliation: {
      ran: true,
      critical: 1,
      summary: { critical: 1 },
      findings: [
        {
          status: 'DRIFT',
          symbol: 'SPY',
          expiration: '2026-09-11',
          tradeId: 't1',
          detail: 'strikes differ',
        },
      ],
    },
  })

  it('classifies the run CRITICAL', () => {
    assert.equal(summarizeSweepRun(incident).severity, 'critical')
  })

  it('counts both criticals and surfaces both lines verbatim', () => {
    const s = summarizeSweepRun(incident)
    assert.equal(s.criticalCount, 2)
    assert.ok(s.criticalLines.some((l) => /RECONCILIATION DRIFT/.test(l)))
    assert.ok(s.criticalLines.some((l) => /REJECTED immediately after placement/.test(l)))
  })

  it('does NOT double-count reconciliation.critical — those are already flags', () => {
    // critical:1 in reconciliation + 1 flag for it must total 1, not 2.
    const s = summarizeSweepRun(
      report({
        flagged: [flag('critical', 'RECONCILIATION DRIFT — SPY 2026-09-11: strikes differ')],
        reconciliation: { ran: true, critical: 1, summary: {}, findings: [] },
      }),
    )
    assert.equal(s.criticalCount, 1)
  })

  it('says "needs your eyes" in the headline', () => {
    assert.match(summarizeSweepRun(incident).headline, /2 CRITICAL/)
    assert.match(summarizeSweepRun(incident).headline, /needs your eyes/)
  })
})

// --------------------------------------------------------
describe('summarizeSweepRun — the wallpaper hazard', () => {
  // The decided, permanent steady state for a multi-root index (v2.4).
  const spxRoutine = flag(
    'routine',
    'SPX — SPX trades under multiple OCC roots; place the GTC manually at 50% of current net credit',
  )

  it('a routine refusal is a WARNING, never critical', () => {
    const s = summarizeSweepRun(report({ flagged: [spxRoutine] }))
    assert.equal(s.severity, 'warning')
    assert.equal(s.criticalCount, 0)
    assert.equal(s.warningCount, 1)
  })

  it('routine refusals never escalate no matter how many are held', () => {
    const s = summarizeSweepRun(report({ flagged: [spxRoutine, spxRoutine, spxRoutine] }))
    assert.equal(s.severity, 'warning')
    assert.equal(s.criticalCount, 0)
  })

  it('one critical alongside routine refusals still reads critical', () => {
    const s = summarizeSweepRun(
      report({ flagged: [spxRoutine, flag('critical', 'partially filled — resolve manually')] }),
    )
    assert.equal(s.severity, 'critical')
    assert.equal(s.criticalCount, 1)
    assert.equal(s.warningCount, 1)
    assert.match(s.headline, /1 CRITICAL, 1 warning/)
  })

  it('severity comes from the stamp, NOT the reason text', () => {
    // Identical prose, opposite stamps. Re-wording a reason must never
    // silently re-classify it.
    const text = 'SPX — SPX trades under multiple OCC roots'
    assert.equal(summarizeSweepRun(report({ flagged: [flag('routine', text)] })).severity, 'warning')
    assert.equal(
      summarizeSweepRun(report({ flagged: [flag('critical', text)] })).severity,
      'critical',
    )
  })
})

// --------------------------------------------------------
describe('summarizeSweepRun — a clean run', () => {
  it('is ok and says what it did', () => {
    const s = summarizeSweepRun(
      report({ placed: [{ tradeId: 't1', symbol: 'SPY', orderId: '1', price: '2.58' }] }),
    )
    assert.equal(s.severity, 'ok')
    assert.equal(s.criticalCount, 0)
    assert.equal(s.warningCount, 0)
    assert.match(s.headline, /Clean — placed 1/)
  })

  it('an idle run still produces a non-empty headline', () => {
    const s = summarizeSweepRun(report())
    assert.equal(s.severity, 'ok')
    assert.equal(s.headline, 'Clean — nothing to do')
  })
})

// --------------------------------------------------------
describe('summarizeSweepRun — errors outrank observations', () => {
  it('a sweep that aborted before planning is critical', () => {
    const s = summarizeSweepRun(report({ errors: ['sweep aborted before planning: 401'] }))
    assert.equal(s.severity, 'critical')
    assert.match(s.criticalLines[0], /^SWEEP ERROR — /)
  })

  it('errors sort ahead of flags', () => {
    const s = summarizeSweepRun(
      report({ errors: ['boom'], flagged: [flag('critical', 'a flag')] }),
    )
    assert.match(s.criticalLines[0], /SWEEP ERROR/)
  })
})

// --------------------------------------------------------
describe('summarizeSweepRun — ran:false is never a clean bill (v2.8.1 doctrine)', () => {
  it('reconciliation that did not run forces CRITICAL even with no flags', () => {
    const s = summarizeSweepRun(
      report({ reconciliation: { ran: false, reason: 'positions fetch 500', critical: 0, findings: [] } }),
    )
    assert.equal(s.severity, 'critical')
    assert.match(s.criticalLines[0], /RECONCILIATION DID NOT RUN/)
    assert.match(s.criticalLines[0], /NOT a clean bill of health/)
  })

  it('carries the reason through', () => {
    const s = summarizeSweepRun(
      report({ reconciliation: { ran: false, reason: 'positions fetch 500', critical: 0, findings: [] } }),
    )
    assert.match(s.criticalLines[0], /positions fetch 500/)
  })

  // The route pushes its own flag for this. Guarantee + detail line, not two lines.
  it('does not duplicate when the route already flagged it', () => {
    const s = summarizeSweepRun(
      report({
        flagged: [flag('critical', 'RECONCILIATION DID NOT RUN (boom) — this is NOT a clean bill')],
        reconciliation: { ran: false, reason: 'boom', critical: 0, findings: [] },
      }),
    )
    assert.equal(s.criticalCount, 1)
  })

  // The guarantee must survive the push site being changed or removed.
  it('still fires if the route flag is absent', () => {
    const s = summarizeSweepRun(
      report({ reconciliation: { ran: false, critical: 0, findings: [] } }),
    )
    assert.equal(s.criticalCount, 1)
  })
})

// --------------------------------------------------------
describe('summarizeSweepRun — a forgotten pause is a silent state', () => {
  it('surfaces the pause as a warning with the withheld count', () => {
    const s = summarizeSweepRun(
      report({
        placementPaused: true,
        wouldHavePlaced: [{ tradeId: 't1', symbol: 'SPY', targetDebit: '2.58' }],
      }),
    )
    assert.equal(s.severity, 'warning')
    assert.match(s.warningLines[0], /PAUSED/)
    assert.match(s.warningLines[0], /1 GTC\(s\) withheld/)
  })

  it('an unpaused run says nothing about pausing', () => {
    const s = summarizeSweepRun(report())
    assert.equal(s.warningLines.length, 0)
  })
})

// --------------------------------------------------------
describe('summarizeSweepRun — 21-DTE alerts are warnings', () => {
  it('carries the alert message', () => {
    const s = summarizeSweepRun(
      report({
        alerts: [{ tradeId: 't1', symbol: 'SPY', dte: 21, message: '21-DTE — close SPY manually' }],
      }),
    )
    assert.equal(s.severity, 'warning')
    assert.match(s.warningLines[0], /21-DTE — close SPY manually/)
  })
})

// --------------------------------------------------------
describe('expectedRunsBetween — weekday cron instants at 21:15 UTC', () => {
  it('counts nothing across a few minutes', () => {
    assert.equal(
      expectedRunsBetween(new Date('2026-08-06T22:05:00Z'), new Date('2026-08-06T22:30:00Z')),
      0,
    )
  })

  it('counts one across a single weekday boundary', () => {
    // Thu 22:05 → Fri 22:05 crosses Friday's 21:15.
    assert.equal(
      expectedRunsBetween(new Date('2026-08-06T22:05:00Z'), new Date('2026-08-07T22:05:00Z')),
      1,
    )
  })

  // The reason the naive "hours elapsed" rule is wrong.
  it('Friday run → Monday morning is ZERO missed runs, not three', () => {
    // Fri Aug 7 22:05 → Mon Aug 10 12:00 (before Monday's 21:15).
    assert.equal(
      expectedRunsBetween(new Date('2026-08-07T22:05:00Z'), new Date('2026-08-10T12:00:00Z')),
      0,
    )
  })

  it('Friday run → Monday evening is one', () => {
    assert.equal(
      expectedRunsBetween(new Date('2026-08-07T22:05:00Z'), new Date('2026-08-10T21:30:00Z')),
      1,
    )
  })

  it('skips the weekend when counting a long gap', () => {
    // Thu Aug 6 22:05 → Tue Aug 11 22:00. Weekday instants strictly after:
    // Fri 7, Mon 10, Tue 11 = 3. Sat/Sun contribute nothing.
    assert.equal(
      expectedRunsBetween(new Date('2026-08-06T22:05:00Z'), new Date('2026-08-11T22:00:00Z')),
      3,
    )
  })

  it('a future `since` counts zero rather than going negative', () => {
    assert.equal(
      expectedRunsBetween(new Date('2026-08-10T00:00:00Z'), new Date('2026-08-07T00:00:00Z')),
      0,
    )
  })

  it('an invalid date counts zero rather than throwing', () => {
    assert.equal(expectedRunsBetween(new Date('nonsense'), new Date('2026-08-07T00:00:00Z')), 0)
  })
})

// --------------------------------------------------------
describe('sweepFreshness', () => {
  it('never recorded is its own state, not "fresh"', () => {
    const f = sweepFreshness(null, new Date('2026-08-07T12:00:00Z'))
    assert.equal(f.state, 'never')
    assert.match(f.message, /No sweep run has ever been recorded/)
  })

  it('a run this afternoon is fresh', () => {
    const f = sweepFreshness(new Date('2026-08-06T22:05:00Z'), new Date('2026-08-07T12:00:00Z'))
    assert.equal(f.state, 'fresh')
    assert.equal(f.message, '')
  })

  // Vercel Hobby drift observed live: 21:17 on Aug 4, 22:05 on Aug 5 and 6.
  it('one missed run is tolerated — 50 min of observed Vercel drift', () => {
    const f = sweepFreshness(new Date('2026-08-06T22:05:00Z'), new Date('2026-08-07T21:20:00Z'))
    assert.equal(f.missedRuns, 1)
    assert.equal(f.state, 'fresh')
  })

  it('two missed runs is stale — drift cannot explain that', () => {
    const f = sweepFreshness(new Date('2026-08-05T22:05:00Z'), new Date('2026-08-07T21:20:00Z'))
    assert.equal(f.missedRuns, MISSED_RUNS_BEFORE_STALE)
    assert.equal(f.state, 'stale')
    assert.match(f.message, /missed 2 scheduled runs/)
    assert.match(f.message, /NOT being placed/)
  })

  it('a weekend cannot make a Friday run look stale', () => {
    // Friday 22:05 → Sunday noon. No weekday instants in between.
    const f = sweepFreshness(new Date('2026-08-07T22:05:00Z'), new Date('2026-08-09T12:00:00Z'))
    assert.equal(f.state, 'fresh')
  })
})
