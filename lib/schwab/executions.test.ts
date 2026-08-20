import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { executionScope, movedNothing } from './executions'
import { GOLDEN_FILLS } from '../journal/golden-fills.fixture'

describe('executionScope — the three values', () => {
  it("'FILL' means contracts really moved", () => {
    assert.equal(executionScope({ activityType: 'EXECUTION', executionType: 'FILL' }), 'FILL')
  })

  it("'CANCELED' is a known ZERO, not an unknown", () => {
    assert.equal(executionScope({ activityType: 'EXECUTION', executionType: 'CANCELED' }), 'NONE')
  })

  it('an ABSENT executionType is UNKNOWN — never assumed to be a fill', () => {
    assert.equal(executionScope({ executionLegs: [] }), 'UNKNOWN')
  })

  it('an unrecognised label is UNKNOWN, not silently zeroed', () => {
    // The failure this guards: a future Schwab label quietly deleting real
    // contracts from the identity.
    assert.equal(executionScope({ executionType: 'PARTIAL_FILL' }), 'UNKNOWN')
  })

  it('the label is matched case-insensitively', () => {
    assert.equal(executionScope({ executionType: 'fill' }), 'FILL')
    assert.equal(executionScope({ executionType: 'canceled' }), 'NONE')
  })
})

describe('movedNothing — the proposal-side helper', () => {
  it('is true ONLY for an explicit cancellation', () => {
    assert.equal(movedNothing({ executionType: 'CANCELED' }), true)
    assert.equal(movedNothing({ executionType: 'FILL' }), false)
  })

  it('is FALSE for UNKNOWN — the proposal paths keep reading what they always read', () => {
    // Deliberately the opposite of orderEffect, which refuses on UNKNOWN.
    // Those paths sit behind their own refuse-don't-guess gates; the identity
    // is a proof and cannot afford a maybe.
    assert.equal(movedNothing({}), false)
    assert.equal(movedNothing({ executionType: 'SOMETHING_NEW' }), false)
  })
})

describe('against the live payloads', () => {
  it('SPY_CANCELED_GTC — a cancellation Schwab filed as an EXECUTION', () => {
    const activity = GOLDEN_FILLS.SPY_CANCELED_GTC.orderActivityCollection![0]
    // Every trap in one record: the activity says EXECUTION, the legs carry a
    // NON-ZERO quantity, and only executionType tells the truth.
    assert.equal(activity.activityType, 'EXECUTION')
    assert.equal(activity.executionLegs!.every((l) => l.quantity === 1), true)
    assert.equal(executionScope(activity), 'NONE')
  })

  it('every other golden fixture is a real FILL', () => {
    for (const [name, order] of Object.entries(GOLDEN_FILLS)) {
      if (name === 'SPY_CANCELED_GTC') continue
      for (const activity of order.orderActivityCollection ?? []) {
        assert.equal(executionScope(activity), 'FILL', `${name} should read as a fill`)
      }
    }
  })
})
