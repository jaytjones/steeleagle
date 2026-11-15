import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { reconcileJournal, type ReconcileFinding, type ReconcilePosition, type ReconcileTrade } from './reconcile'
import {
  resolvedInRun,
  resolvedNote,
  runWritesOf,
  unexplainedResolutionReason,
  type RunWrite,
} from './reconcile-in-run'
import type { StructureEvent } from './current-structure'

const NOW = new Date('2026-11-11T22:04:00Z') // Nov 11 sweep, 4:04 PM CT
const T0 = '2026-11-06T18:39:00.000Z'

function openEvents([lp, sp, sc, lc]: [number, number, number, number], expiration: string): StructureEvent[] {
  return (
    [
      ['long_put', lp],
      ['short_put', sp],
      ['short_call', sc],
      ['long_call', lc],
    ] as const
  ).map(([leg, strike], i) => ({
    eventType: 'open',
    leg,
    strike,
    expiration,
    occurredAt: T0,
    createdAt: `2026-11-06T18:39:0${i}.000Z`,
  }))
}

const trade = (id: string, strikes: [number, number, number, number], expiration = '2026-12-18'): ReconcileTrade => ({
  id,
  symbol: 'SPY',
  currentExpiration: expiration,
  contracts: 1,
  events: openEvents(strikes, expiration),
})

const condor = ([lp, sp, sc, lc]: [number, number, number, number], expiration = '2026-12-18'): ReconcilePosition => ({
  kind: 'IRON_CONDOR',
  underlying: 'SPY',
  expiration,
  quantity: 1,
  legs: [
    { role: 'LONG_PUT', strike: lp },
    { role: 'SHORT_PUT', strike: sp },
    { role: 'SHORT_CALL', strike: sc },
    { role: 'LONG_CALL', strike: lc },
  ],
})

const finding = (over: Partial<ReconcileFinding>): ReconcileFinding => ({
  status: 'PHANTOM',
  severity: 'critical',
  symbol: 'SPY',
  expiration: '2026-12-04',
  tradeId: 'T1',
  journalStrikes: null,
  accountStrikes: null,
  journalContracts: 1,
  accountContracts: null,
  detail: 'the journal lists this trade as OPEN but the account holds no position',
  ...over,
})

describe('resolvedInRun — the live nights it exists for', () => {
  it('Nov 11 DRIFT: an auto-roll resolves it, end-to-end through reconcileJournal', () => {
    // Account already holds the rolled puts; the journal catches up in step (d1).
    const positions = [condor([710, 740, 770, 800])]
    const before = reconcileJournal([trade('2148a833', [650, 680, 770, 800])], positions, NOW)
    const after = reconcileJournal([trade('2148a833', [710, 740, 770, 800])], positions, NOW)
    assert.equal(before[0].status, 'DRIFT')
    assert.equal(after[0].status, 'MATCH')

    const writes: RunWrite[] = [{ tradeId: '2148a833', orderId: '1008633815423', kind: 'auto-roll' }]
    const [r] = resolvedInRun(before, after, writes)
    assert.equal(r.status, 'DRIFT')
    assert.deepEqual(r.resolvedBy, { kind: 'auto-roll', orderId: '1008633815423' })
    assert.match(resolvedNote(r)!, /DRIFT on SPY 2026-12-18 resolved in this run by the auto-journaled roll \(order 1008633815423\)/)
  })

  it('Nov 5 PHANTOM: the closed trade drops out of the re-read journal entirely', () => {
    const before = [finding({ tradeId: 'd2730ffd', symbol: 'IWM', expiration: '2026-11-20' })]
    const writes: RunWrite[] = [{ tradeId: 'd2730ffd', orderId: '1008509613966', kind: 'auto-close' }]
    const [r] = resolvedInRun(before, [], writes)
    assert.deepEqual(r.resolvedBy, { kind: 'auto-close', orderId: '1008509613966' })
  })

  it('Nov 10 PHANTOM: a filled GTC journaled by step (a) is a write too', () => {
    const report = {
      reconciled: [{ tradeId: '2aeb912a', orderId: '1008593573274' }],
      autoJournal: { written: [], rolls: { written: [] }, entries: { written: [] } },
    }
    const [r] = resolvedInRun([finding({ tradeId: '2aeb912a' })], [], runWritesOf(report))
    assert.deepEqual(r.resolvedBy, { kind: 'exit-fill', orderId: '1008593573274' })
  })
})

describe('resolvedInRun — nothing goes silent', () => {
  it('a critical still present at the end is NOT resolved (it is flagged from the final pass)', () => {
    const f = finding({})
    assert.deepEqual(resolvedInRun([f], [f], [{ tradeId: 'T1', orderId: 'o', kind: 'auto-close' }]), [])
  })

  it('a FAILED write leaves the finding in the final pass, so it stays critical', () => {
    // The close threw: no write recorded, trade still open, still PHANTOM.
    const f = finding({})
    assert.deepEqual(resolvedInRun([f], [f], []), [])
  })

  it('a status CHANGE on the same subject is not "resolved" — the final critical carries it', () => {
    const before = finding({ status: 'DRIFT' })
    const after = finding({ status: 'PHANTOM' })
    assert.deepEqual(resolvedInRun([before], [after], [{ tradeId: 'T1', orderId: 'o', kind: 'auto-roll' }]), [])
  })

  it('a resolution NO write explains is reported with resolvedBy null (→ a warning)', () => {
    const [r] = resolvedInRun([finding({})], [], [{ tradeId: 'OTHER', orderId: 'o', kind: 'auto-close' }])
    assert.equal(r.resolvedBy, null)
    assert.equal(resolvedNote(r), null)
    assert.match(unexplainedResolutionReason(r), /^RECONCILIATION PHANTOM — SPY 2026-12-04 .*no write in this run explains it/)
  })

  it('a finding with no trade id can never be attributed, even if a write has a null-ish match', () => {
    const [r] = resolvedInRun([finding({ tradeId: null, status: 'UNCOMPARABLE' })], [], [
      { tradeId: '', orderId: 'o', kind: 'auto-entry' },
    ])
    assert.equal(r.resolvedBy, null)
  })

  it('ignores non-critical step-0 findings (UNIMPORTED / MATCH are not flags)', () => {
    const info = finding({ status: 'UNIMPORTED', severity: 'info', tradeId: null })
    const ok = finding({ status: 'MATCH', severity: 'ok' })
    assert.deepEqual(resolvedInRun([info, ok], [], []), [])
  })

  it('a NEW critical that appears only at the end is not this function\'s business (the final pass flags it)', () => {
    assert.deepEqual(resolvedInRun([], [finding({})], []), [])
  })
})

describe('runWritesOf', () => {
  it('collects every journal write the sweep made, tolerating pre-v2.15 report shapes', () => {
    assert.deepEqual(runWritesOf({ reconciled: [] }), [])
    const w = runWritesOf({
      reconciled: [{ tradeId: 'a', orderId: '1' }],
      autoJournal: {
        written: [{ tradeId: 'd', orderId: '4' }],
        rolls: { written: [{ tradeId: 'c', orderId: '3' }] },
        entries: { written: [{ tradeId: 'b', orderId: '2' }] },
      },
    })
    assert.deepEqual(
      w.map((x) => `${x.kind}:${x.tradeId}`),
      ['exit-fill:a', 'auto-entry:b', 'auto-roll:c', 'auto-close:d'],
    )
  })
})
