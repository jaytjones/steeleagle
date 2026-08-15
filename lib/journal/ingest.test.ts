import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildIngestionReport, ingestionDidNotRun, ingestionFlags } from './ingest'
import { checkBalance } from './balance'

const NOW = new Date('2026-08-14T21:00:00Z')
const clean = () => checkBalance(new Map(), new Map(), [], NOW)

const base = {
  anchorAt: '2026-08-13T22:12:00.000Z',
  snapshotAt: '2026-08-14T22:12:00.000Z',
  inserted: 3,
  updated: 7,
  failed: 0,
  pending: 0,
}

describe('ingestionDidNotRun', () => {
  it('is pessimistic — ran:false with UNANCHORED, never an empty clean result', () => {
    const r = ingestionDidNotRun('positions fetch failed')
    assert.equal(r.ran, false)
    assert.equal(r.balance.status, 'UNANCHORED')
    assert.equal(r.reason, 'positions fetch failed')
  })

  it('produces exactly one CRITICAL flag saying it is not a clean bill', () => {
    const flags = ingestionFlags(ingestionDidNotRun('boom'))
    assert.equal(flags.length, 1)
    assert.equal(flags[0].severity, 'critical')
    assert.match(flags[0].reason, /INGESTION DID NOT RUN \(boom\)/)
    assert.match(flags[0].reason, /NOT a clean bill of health/)
  })
})

describe('ingestionFlags — a clean balanced run is SILENT', () => {
  it('emits no flags when the identity closed and nothing is pending', () => {
    // Silence is correct here: a zero residual is a PROOF, not merely an
    // absence of complaints. Adding a reassuring line would make the genuine
    // signals harder to spot.
    const r = buildIngestionReport({ ...base, balance: clean() })
    assert.deepEqual(ingestionFlags(r), [])
    assert.equal(r.balance.status, 'BALANCED')
    assert.equal(r.balance.residual, '(empty)')
  })
})

describe('ingestionFlags — severities (the wallpaper hazard)', () => {
  it('UNANCHORED is ROUTINE — expected exactly once, self-resolving', () => {
    const r = buildIngestionReport({ ...base, anchorAt: null, balance: null })
    const flags = ingestionFlags(r)
    assert.equal(r.balance.status, 'UNANCHORED')
    assert.equal(flags.length, 1)
    assert.equal(flags[0].severity, 'routine')
    assert.match(flags[0].reason, /Expected exactly once/)
    // and it says what a REPEAT would mean, so a stuck state is legible
    assert.match(flags[0].reason, /If this repeats/)
  })

  it('an UNEXPLAINED residual is CRITICAL', () => {
    const balance = checkBalance(new Map([['SPY   260911P00700000', -1]]), new Map(), [], NOW)
    const flags = ingestionFlags(buildIngestionReport({ ...base, balance }))
    assert.equal(flags.length, 1)
    assert.equal(flags[0].severity, 'critical')
    assert.match(flags[0].reason, /INGESTION UNEXPLAINED/)
  })

  it('an EXPIRED residual is ROUTINE — reconcile.ts already voices it as PHANTOM', () => {
    // reconcile rates an EXPIRED phantom `warning`, not critical. Two reds for
    // one event trains the operator to ignore both.
    const balance = checkBalance(new Map([['SPY   260807P00700000', -1]]), new Map(), [], NOW)
    const flags = ingestionFlags(buildIngestionReport({ ...base, balance }))
    assert.equal(flags.length, 1)
    assert.equal(flags[0].severity, 'routine')
    assert.match(flags[0].reason, /INGESTION EXPIRED/)
  })

  it('UNRELIABLE is CRITICAL and says a zero residual would prove nothing', () => {
    const balance = checkBalance(new Map(), new Map(), ['order 5: leg 99 orphaned'], NOW)
    const flags = ingestionFlags(buildIngestionReport({ ...base, balance }))
    assert.equal(flags[0].severity, 'critical')
    assert.match(flags[0].reason, /UNRELIABLE/)
    assert.match(flags[0].reason, /would prove nothing/)
    assert.match(flags[0].reason, /leg 99 orphaned/)
  })

  it('a failed ledger write is CRITICAL — those orders never reach the inbox', () => {
    const r = buildIngestionReport({ ...base, failed: 2, balance: clean() })
    const flags = ingestionFlags(r)
    assert.equal(flags[0].severity, 'critical')
    assert.match(flags[0].reason, /2 fill\(s\) could not be ledgered/)
  })

  it('a pending count is NOT flagged — it is not yet meaningful (step 7)', () => {
    // Until match-fill can tell an already-journaled fill from one needing
    // attention, every ledgered order is 'pending'. The first live run reported
    // 122, nearly all journaled months ago. Flagging that would be FALSE, and a
    // false count repeated every run is the wallpaper hazard plus an error.
    const r = buildIngestionReport({ ...base, pending: 122, balance: clean() })
    assert.deepEqual(ingestionFlags(r), [])
    assert.equal(r.pending, 122, 'still reported as data')
  })

  it('reports every distinct problem rather than stopping at the first', () => {
    const balance = checkBalance(
      new Map([
        ['SPY   260807P00700000', -1], // expired  → routine
        ['SPY   260911P00700000', -1], // unexplained → critical
      ]),
      new Map(),
      [],
      NOW,
    )
    const flags = ingestionFlags(buildIngestionReport({ ...base, failed: 1, pending: 2, balance }))
    assert.equal(flags.filter((f) => f.severity === 'critical').length, 2) // failed + unexplained
    assert.equal(flags.filter((f) => f.severity === 'routine').length, 1) // expired only
  })
})

describe('buildIngestionReport', () => {
  it('carries the anchor and the newly written snapshot separately', () => {
    const r = buildIngestionReport({ ...base, balance: clean() })
    assert.equal(r.anchorAt, '2026-08-13T22:12:00.000Z')
    assert.equal(r.snapshotAt, '2026-08-14T22:12:00.000Z')
    assert.deepEqual(r.fills, { inserted: 3, updated: 7, failed: 0 })
  })

  it('renders a residual readably rather than as a Map', () => {
    const balance = checkBalance(
      new Map([['SPY   260911P00765000', -1], ['SPY   260911P00750000', 1]]),
      new Map(),
      [],
      NOW,
    )
    const r = buildIngestionReport({ ...base, balance })
    assert.equal(r.balance.residual, 'SPY   260911P00750000 +1, SPY   260911P00765000 -1')
  })

  it('a null balance is UNANCHORED, never a fabricated BALANCED', () => {
    const r = buildIngestionReport({ ...base, anchorAt: null, balance: null })
    assert.equal(r.balance.status, 'UNANCHORED')
    assert.deepEqual(r.balance.findings, [])
  })
})
