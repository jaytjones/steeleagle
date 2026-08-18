import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildExitLinks,
  exitLinkKey,
  exitLinksFor,
  type ExitLinkTrade,
} from './exit-links'
import type { StructureEvent } from '../journal/current-structure'

const ev = (
  eventType: StructureEvent['eventType'],
  leg: StructureEvent['leg'],
  strike: number,
  expiration: string,
): StructureEvent => ({
  eventType,
  leg,
  strike,
  expiration,
  occurredAt: '2026-08-01T14:00:00Z',
  createdAt: '2026-08-01T14:00:00Z',
})

/** A plain, priceable condor event log. */
const condorEvents = (
  [lp, sp, sc, lc]: [number, number, number, number],
  expiration: string,
): StructureEvent[] => [
  ev('open', 'long_put', lp, expiration),
  ev('open', 'short_put', sp, expiration),
  ev('open', 'short_call', sc, expiration),
  ev('open', 'long_call', lc, expiration),
]

function trade(over: Partial<ExitLinkTrade> = {}): ExitLinkTrade {
  const expiration = over.currentExpiration ?? '2026-09-18'
  return {
    id: 'trade-A',
    symbol: 'GLD',
    status: 'open',
    openedAt: '2026-07-20T15:00:00Z',
    currentExpiration: expiration,
    contracts: 1,
    totalCreditCollected: 455,
    totalDebitPaid: 0,
    exitOrderId: null,
    events: condorEvents([375, 395, 400, 420], expiration),
    ...over,
  }
}

/** The live pair: GLD 2026-09-18, entered at different times for $455 and $414. */
const GLD_A = trade({
  id: 'trade-A',
  openedAt: '2026-07-20T15:00:00Z',
  totalCreditCollected: 455,
  exitOrderId: '1007605997326',
})
const GLD_B = trade({
  id: 'trade-B',
  openedAt: '2026-07-24T15:30:00Z',
  totalCreditCollected: 414,
  exitOrderId: '1007605997334',
})

describe('buildExitLinks — the last-wins defect', () => {
  it('THE GLD CASE — two trades on one key produce TWO links, not one', () => {
    // `new Map(trades.map(t => [key, t]))` returned trade B only, so one live
    // standing GTC was invisible on the Monitor.
    const links = exitLinksFor(buildExitLinks([GLD_A, GLD_B]), 'GLD', '2026-09-18')
    assert.equal(links.length, 2)
    assert.deepEqual(
      links.map((l) => l.exitOrderId),
      ['1007605997326', '1007605997334'],
    )
  })

  it('prices each trade from ITS OWN credit — never a blended average', () => {
    const links = exitLinksFor(buildExitLinks([GLD_A, GLD_B]), 'GLD', '2026-09-18')
    // 455/100/2 = 2.275 → '2.27' (formatOrderPrice rounds down at the cent);
    // 414/100/2 = 2.07. Two real entries, two different targets.
    assert.deepEqual(
      links.map((l) => l.targetDebit),
      ['2.27', '2.07'],
    )
  })

  it('orders by openedAt, then id — deterministic across refreshes', () => {
    const shuffled = buildExitLinks([GLD_B, GLD_A])
    assert.deepEqual(
      exitLinksFor(shuffled, 'GLD', '2026-09-18').map((l) => l.tradeId),
      ['trade-A', 'trade-B'],
    )

    const sameInstant = buildExitLinks([
      trade({ id: 'zzz', openedAt: '2026-07-20T15:00:00Z' }),
      trade({ id: 'aaa', openedAt: '2026-07-20T15:00:00Z' }),
    ])
    assert.deepEqual(
      exitLinksFor(sameInstant, 'GLD', '2026-09-18').map((l) => l.tradeId),
      ['aaa', 'zzz'],
    )
  })

  it('carries each trade\'s OWN lot size, not the aggregated position quantity', () => {
    const links = exitLinksFor(buildExitLinks([GLD_A, GLD_B]), 'GLD', '2026-09-18')
    assert.deepEqual(links.map((l) => l.contracts), [1, 1])
  })
})

describe('buildExitLinks — one trade per key still behaves as before', () => {
  it('links a single trade', () => {
    const links = exitLinksFor(buildExitLinks([trade({ symbol: 'SPY' })]), 'SPY', '2026-09-18')
    assert.equal(links.length, 1)
    assert.equal(links[0].manualGtc, false)
    assert.equal(links[0].exitOrderId, null)
  })

  it('returns an EMPTY array for an unmatched position — never undefined', () => {
    assert.deepEqual(exitLinksFor(buildExitLinks([GLD_A]), 'SPY', '2026-09-18'), [])
  })

  it('keys on symbol|expiration, so a rolled-away expiration does not collide', () => {
    const byKey = buildExitLinks([GLD_A, trade({ id: 'later', currentExpiration: '2026-10-16' })])
    assert.equal(exitLinksFor(byKey, 'GLD', '2026-09-18').length, 1)
    assert.equal(exitLinksFor(byKey, 'GLD', '2026-10-16').length, 1)
    assert.equal(exitLinkKey('GLD', '2026-09-18'), 'GLD|2026-09-18')
  })
})

describe('buildExitLinks — refusals never drop the link', () => {
  it('a structure the sweep cannot price is manualGtc, still linked', () => {
    // A diagonal: the short put rolled to a LATER expiration than the rest.
    const diagonal = trade({
      id: 'diag',
      events: [
        ...condorEvents([375, 395, 400, 420], '2026-09-18'),
        ev('roll_close', 'short_put', 395, '2026-09-18'),
        ev('roll_open', 'short_put', 390, '2026-10-16'),
      ],
    })
    const [link] = exitLinksFor(buildExitLinks([diagonal]), 'GLD', '2026-09-18')
    assert.equal(link.manualGtc, true)
    assert.equal(link.tradeId, 'diag')
  })

  it('an unpriceable target leaves targetDebit null but KEEPS the standing GTC visible', () => {
    // Net credit ≤ 0 — computeExitDebit refuses. Hiding the row is exactly how
    // a live order goes unseen, so the link stands with a null target.
    const upsideDown = trade({
      id: 'ud',
      totalCreditCollected: 100,
      totalDebitPaid: 140,
      exitOrderId: '1007000000001',
    })
    const [link] = exitLinksFor(buildExitLinks([upsideDown]), 'GLD', '2026-09-18')
    assert.equal(link.targetDebit, null)
    assert.equal(link.exitOrderId, '1007000000001')
  })

  it('drops CLOSED trades — a closed trade has no live exit to advertise', () => {
    const byKey = buildExitLinks([GLD_A, trade({ id: 'closed', status: 'closed' })])
    assert.deepEqual(
      exitLinksFor(byKey, 'GLD', '2026-09-18').map((l) => l.tradeId),
      ['trade-A'],
    )
  })
})
