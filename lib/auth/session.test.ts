/**
 * Run with:  npx tsx --test lib/auth/session.test.ts
 *
 * Pure tests for the signed-session logic. AUTH_SECRET is set/unset
 * per-case via process.env (the module reads it lazily per call).
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSessionToken,
  verifySessionToken,
  safeEqual,
  SESSION_TTL_MS,
} from './session'

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef'

describe('session tokens', () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = SECRET
  })

  it('round-trips: created token verifies', async () => {
    const token = await createSessionToken()
    assert.equal(await verifySessionToken(token), true)
  })

  it('expires: token past TTL fails', async () => {
    const now = Date.now()
    const token = await createSessionToken(now)
    assert.equal(await verifySessionToken(token, now + SESSION_TTL_MS + 1), false)
    assert.equal(await verifySessionToken(token, now + SESSION_TTL_MS - 1000), true)
  })

  it('rejects tampered expiry (signature no longer matches)', async () => {
    const token = await createSessionToken()
    const [exp, sig] = token.split('.')
    const forged = `${Number(exp) + 9_999_999}.${sig}`
    assert.equal(await verifySessionToken(forged), false)
  })

  it('rejects tampered signature', async () => {
    const token = await createSessionToken()
    const flipped = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')
    assert.equal(await verifySessionToken(flipped), false)
  })

  it('rejects garbage / empty / missing tokens', async () => {
    assert.equal(await verifySessionToken(undefined), false)
    assert.equal(await verifySessionToken(''), false)
    assert.equal(await verifySessionToken('not-a-token'), false)
    assert.equal(await verifySessionToken('.onlysig'), false)
    assert.equal(await verifySessionToken('123.'), false)
  })

  it('a token signed with a different secret fails (secret rotation logs out)', async () => {
    const token = await createSessionToken()
    process.env.AUTH_SECRET = 'rotated-secret-0123456789abcdef0123456789ab'
    assert.equal(await verifySessionToken(token), false)
  })

  it('fails CLOSED with a missing or short AUTH_SECRET', async () => {
    process.env.AUTH_SECRET = SECRET
    const token = await createSessionToken()
    delete process.env.AUTH_SECRET
    assert.equal(await verifySessionToken(token), false)
    process.env.AUTH_SECRET = 'short'
    assert.equal(await verifySessionToken(token), false)
    await assert.rejects(() => createSessionToken(), /AUTH_SECRET/)
  })
})

describe('safeEqual', () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = SECRET
  })

  it('true for equal strings, false otherwise (incl. length differences)', async () => {
    assert.equal(await safeEqual(SECRET, 'hunter2', 'hunter2'), true)
    assert.equal(await safeEqual(SECRET, 'hunter2', 'hunter3'), false)
    assert.equal(await safeEqual(SECRET, 'hunter2', 'hunter22'), false)
    assert.equal(await safeEqual(SECRET, '', ''), true)
    assert.equal(await safeEqual(SECRET, '', 'x'), false)
  })
})
