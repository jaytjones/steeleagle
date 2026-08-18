import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  REAUTH_WARN_HOURS,
  reauthWindow,
  refreshWindowFrom,
  formatDeadlineCt,
} from './auth-window'

/** Tuesday 2026-08-18, 10:14 AM CT — the morning after the sweep died. */
const NOW = new Date('2026-08-18T15:14:00Z')

const inHours = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString()

describe('reauthWindow', () => {
  it('is ok with runway to spare', () => {
    const w = reauthWindow(inHours(7 * 24), NOW)
    assert.equal(w.state, 'ok')
    assert.ok(w.hoursRemaining !== null && w.hoursRemaining > REAUTH_WARN_HOURS)
  })

  it('warns INSIDE the window, not after it — the whole point of the fix', () => {
    assert.equal(reauthWindow(inHours(47), NOW).state, 'soon')
    assert.equal(reauthWindow(inHours(REAUTH_WARN_HOURS), NOW).state, 'soon')
    assert.equal(reauthWindow(inHours(49), NOW).state, 'ok')
  })

  it('is expired at and after the deadline', () => {
    assert.equal(reauthWindow(NOW.toISOString(), NOW).state, 'expired')
    const past = reauthWindow(inHours(-1), NOW)
    assert.equal(past.state, 'expired')
    assert.ok(past.hoursRemaining !== null && past.hoursRemaining < 0)
  })

  it('THE MONDAY CASE — a slid-forward deadline reads ok, which is why it must not slide', () => {
    // What the DB actually held on 2026-08-17: now(08-14) + 7d. Our clock said
    // fine; Schwab had already revoked the token.
    assert.equal(reauthWindow('2026-08-21T02:36:00Z', new Date('2026-08-17T21:16:00Z')).state, 'ok')
    // Anchored to the real authorization (08-10) it would have been expired,
    // and 'soon' two days earlier.
    assert.equal(reauthWindow('2026-08-17T15:10:00Z', new Date('2026-08-17T21:16:00Z')).state, 'expired')
    assert.equal(reauthWindow('2026-08-17T15:10:00Z', new Date('2026-08-16T09:00:00Z')).state, 'soon')
  })

  it('a missing or malformed deadline is UNKNOWN, never ok', () => {
    for (const bad of [null, undefined, '', 'whenever']) {
      const w = reauthWindow(bad as string | null, NOW)
      assert.equal(w.state, 'unknown')
      assert.equal(w.hoursRemaining, null)
      assert.equal(w.deadlineCt, null)
    }
  })

  it('accepts a Date as well as an ISO string (the DB hydrates timestamptz as a Date)', () => {
    assert.equal(reauthWindow(new Date(inHours(1)), NOW).state, 'soon')
  })
})

describe('the deadline JJ reads', () => {
  it('is stated in Central time', () => {
    // 2026-08-25T15:10Z = 10:10 AM CT (CDT, UTC−5).
    assert.equal(formatDeadlineCt(new Date('2026-08-25T15:10:00Z')), 'Tue, Aug 25, 10:10 AM CT')
  })
})

describe('refreshWindowFrom', () => {
  it('is 7 days from the INTERACTIVE authorization', () => {
    assert.equal(
      refreshWindowFrom(new Date('2026-08-18T15:10:44Z')).toISOString(),
      '2026-08-25T15:10:44.000Z',
    )
  })
})
