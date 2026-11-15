import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCESS_TOKEN_MARGIN_MS,
  LOSER_GRACE_MS,
  createTokenProvider,
  isFresh,
  supersededToken,
  type RefreshDeps,
  type TokenEndpointResult,
  type TokenRow,
} from './token-refresh'

/** Sunday 2026-11-15, 12:22 PM CT — the morning the race was found. */
const NOW = new Date('2026-11-15T18:22:08Z').getTime()

const row = (over: Partial<TokenRow> = {}): TokenRow => ({
  access_token: 'AT-old',
  refresh_token: 'RT-1',
  access_token_expires_at: new Date(NOW - 60_000), // lapsed a minute ago
  ...over,
})

const ok = (access: string, refresh = 'RT-1'): TokenEndpointResult => ({
  ok: true,
  tokens: { access_token: access, refresh_token: refresh, expires_in: 1800 },
})

/** A fake DB + Schwab. `rows` is consumed per readRow call; the last repeats. */
function harness(opts: {
  rows: (TokenRow | null)[]
  endpoint: (rt: string) => Promise<TokenEndpointResult>
}) {
  const calls = { endpoint: 0, store: 0, expire: [] as string[], sleeps: [] as number[] }
  let i = 0
  const deps: RefreshDeps = {
    readRow: async () => opts.rows[Math.min(i++, opts.rows.length - 1)],
    callTokenEndpoint: async (rt) => {
      calls.endpoint++
      return opts.endpoint(rt)
    },
    store: async () => {
      calls.store++
    },
    expire: async (reason) => {
      calls.expire.push(reason)
    },
    now: () => NOW,
    sleep: async (ms) => {
      calls.sleeps.push(ms)
    },
  }
  return { provider: createTokenProvider(deps), calls }
}

describe('isFresh', () => {
  it('honours the 2-minute margin', () => {
    assert.equal(isFresh(row({ access_token_expires_at: new Date(NOW + ACCESS_TOKEN_MARGIN_MS + 1) }), NOW), true)
    assert.equal(isFresh(row({ access_token_expires_at: new Date(NOW + ACCESS_TOKEN_MARGIN_MS) }), NOW), false)
  })
  it('accepts the string form and treats an unreadable expiry as stale', () => {
    assert.equal(isFresh(row({ access_token_expires_at: new Date(NOW + 3_600_000).toISOString() }), NOW), true)
    assert.equal(isFresh(row({ access_token_expires_at: 'garbage' }), NOW), false)
  })
})

describe('supersededToken', () => {
  it('is null when the row still holds the token we used, stale', () => {
    assert.equal(supersededToken(row(), 'RT-1', NOW), null)
    assert.equal(supersededToken(null, 'RT-1', NOW), null)
  })
  it('sees a rotated refresh token', () => {
    assert.equal(supersededToken(row({ refresh_token: 'RT-2', access_token: 'AT-new' }), 'RT-1', NOW), 'AT-new')
  })
  it('sees a fresh access token even when Schwab kept the refresh token', () => {
    const fresh = row({ access_token: 'AT-new', access_token_expires_at: new Date(NOW + 1_800_000) })
    assert.equal(supersededToken(fresh, 'RT-1', NOW), 'AT-new')
  })
})

describe('createTokenProvider', () => {
  it('returns a fresh token without touching Schwab', async () => {
    const h = harness({
      rows: [row({ access_token: 'AT-live', access_token_expires_at: new Date(NOW + 1_800_000) })],
      endpoint: async () => assert.fail('must not refresh'),
    })
    assert.equal(await h.provider.getAccessToken(), 'AT-live')
    assert.equal(h.calls.endpoint, 0)
  })

  it('refuses with no token row', async () => {
    const h = harness({ rows: [null], endpoint: async () => assert.fail('must not refresh') })
    await assert.rejects(h.provider.getAccessToken(), /OAuth login required/)
  })

  it('SINGLE FLIGHT: a fan-out of concurrent callers triggers exactly one refresh', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = harness({
      rows: [row()],
      endpoint: async () => {
        await gate
        return ok('AT-new')
      },
    })
    const all = Promise.all(Array.from({ length: 12 }, () => h.provider.getAccessToken()))
    await new Promise((r) => setImmediate(r))
    release()
    const tokens = await all
    assert.deepEqual(new Set(tokens), new Set(['AT-new']))
    assert.equal(h.calls.endpoint, 1)
    assert.equal(h.calls.store, 1)
    assert.deepEqual(h.calls.expire, [])
  })

  it('does not cache a failure: the next caller gets a fresh attempt', async () => {
    let n = 0
    const h = harness({
      rows: [row()],
      endpoint: async () => (++n === 1 ? { ok: false, status: 503, text: 'down' } : ok('AT-new')),
    })
    await assert.rejects(h.provider.getAccessToken(), /503/)
    assert.equal(await h.provider.getAccessToken(), 'AT-new')
    assert.equal(h.calls.endpoint, 2)
  })

  it('a 5xx never burns the window', async () => {
    const h = harness({ rows: [row()], endpoint: async () => ({ ok: false, status: 502, text: 'bad gateway' }) })
    await assert.rejects(h.provider.getAccessToken(), /Token refresh failed: 502/)
    assert.deepEqual(h.calls.expire, [])
    assert.deepEqual(h.calls.sleeps, [])
  })

  it('RACE LOSER (winner already stored): uses the winner token, burns nothing', async () => {
    const winner = row({ access_token: 'AT-winner', access_token_expires_at: new Date(NOW + 1_800_000) })
    const h = harness({
      rows: [row(), winner],
      endpoint: async () => ({ ok: false, status: 400, text: 'invalid_grant' }),
    })
    assert.equal(await h.provider.getAccessToken(), 'AT-winner')
    assert.deepEqual(h.calls.expire, [])
    assert.deepEqual(h.calls.sleeps, [], 'no grace delay needed when the winner is already on file')
  })

  it('RACE LOSER (winner stores late — the 2026-11-15 order): waits the grace delay, then uses it', async () => {
    const winner = row({ access_token: 'AT-winner', refresh_token: 'RT-2' })
    const h = harness({
      rows: [row(), row(), winner],
      endpoint: async () => ({ ok: false, status: 401, text: 'invalid_token' }),
    })
    assert.equal(await h.provider.getAccessToken(), 'AT-winner')
    assert.deepEqual(h.calls.sleeps, [LOSER_GRACE_MS])
    assert.deepEqual(h.calls.expire, [])
  })

  it('GENUINE 4xx (no newer token, even after the grace delay) still records the lapse', async () => {
    const h = harness({
      rows: [row()],
      endpoint: async () => ({ ok: false, status: 400, text: 'invalid_grant' }),
    })
    await assert.rejects(h.provider.getAccessToken(), /Token refresh failed: 400 invalid_grant/)
    assert.deepEqual(h.calls.sleeps, [LOSER_GRACE_MS])
    assert.deepEqual(h.calls.expire, ['400 invalid_grant'])
  })

  it('a genuine 4xx shared by concurrent callers is recorded once and rejects them all', async () => {
    const h = harness({
      rows: [row()],
      endpoint: async () => ({ ok: false, status: 400, text: 'invalid_grant' }),
    })
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => h.provider.getAccessToken()))
    assert.ok(results.every((r) => r.status === 'rejected'))
    assert.equal(h.calls.endpoint, 1)
    assert.equal(h.calls.expire.length, 1)
  })
})
