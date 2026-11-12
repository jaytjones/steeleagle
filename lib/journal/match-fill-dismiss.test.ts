import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { excludeDismissed, summarizeMatches, type FillMatch } from './match-fill'

const m = (orderId: string, actionable = true): FillMatch => ({
  orderId,
  verdict: 'REJECTED_PLACEMENT',
  tradeId: null,
  actionable,
  detail: '',
})

describe('excludeDismissed (v2.17)', () => {
  it('drops exactly the dismissed fills', () => {
    const out = excludeDismissed(
      [m('a'), m('b'), m('c')],
      [
        { orderId: 'a', disposition: 'pending' },
        { orderId: 'b', disposition: 'dismissed' },
        { orderId: 'c', disposition: 'journaled' },
      ],
    )
    assert.deepEqual(out.map((x) => x.orderId), ['a', 'c'])
  })

  it('keeps a fill whose disposition is unknown — surface, never hide', () => {
    const out = excludeDismissed([m('a'), m('ghost')], [{ orderId: 'a', disposition: 'pending' }])
    assert.deepEqual(out.map((x) => x.orderId), ['a', 'ghost'])
  })

  it('only the literal "dismissed" hides', () => {
    const out = excludeDismissed([m('a')], [{ orderId: 'a', disposition: 'DISMISSED' }])
    assert.equal(out.length, 1)
  })

  it('a dismissed fill no longer counts toward the cron actionable warning', () => {
    const matches = [m('a'), m('b')]
    const fills = [
      { orderId: 'a', disposition: 'pending' },
      { orderId: 'b', disposition: 'dismissed' },
    ]
    assert.equal(summarizeMatches(matches).actionable, 2)
    assert.equal(summarizeMatches(excludeDismissed(matches, fills)).actionable, 1)
  })

  it('does not mutate its input', () => {
    const matches = [m('a'), m('b')]
    excludeDismissed(matches, [{ orderId: 'b', disposition: 'dismissed' }])
    assert.equal(matches.length, 2)
  })
})
