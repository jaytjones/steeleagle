/**
 * v2.3 — Cancel GTC planner. Run with:
 *   npx tsx --test lib/strategy/cancel-exit.test.ts
 *
 * The clearColumn assertions are the point: nulling trades.exit_order_id on
 * anything short of a confirmed terminal status lets the next sweep place a
 * duplicate GTC against a live order.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planCancelExit } from './cancel-exit'
import type { SweepOrderState } from './exit-sweep'

function state(over: Partial<SweepOrderState> = {}): SweepOrderState {
  return {
    orderId: '1007074485891',
    status: 'WORKING',
    underlying: 'SPY',
    expiration: '2026-08-28',
    isClose: true,
    filledQuantity: 0,
    remainingQuantity: 1,
    ...over,
  }
}

describe('planCancelExit — before the cancel', () => {
  it('a working GTC is cancellable', () => {
    const p = planCancelExit(state(), 'before')
    assert.equal(p.outcome, 'cancel_required')
    assert.equal(p.clearColumn, false)
  })

  it('an already-terminal GTC clears the record without cancelling', () => {
    const p = planCancelExit(state({ status: 'CANCELED' }), 'before')
    assert.equal(p.outcome, 'terminal')
    assert.equal(p.clearColumn, true)
    assert.match(p.message, /already CANCELED/)
  })

  it('REJECTED and EXPIRED are terminal too', () => {
    for (const status of ['REJECTED', 'EXPIRED', 'REPLACED']) {
      assert.equal(planCancelExit(state({ status }), 'before').outcome, 'terminal')
    }
  })

  // The dangerous case: she clicks Cancel GTC on an order that already filled.
  it('a FILLED GTC reports a CLOSED POSITION, does not clear, and warns off TOS', () => {
    const p = planCancelExit(
      state({ status: 'FILLED', filledQuantity: 1, remainingQuantity: 0 }),
      'before',
    )
    assert.equal(p.outcome, 'filled')
    assert.equal(p.clearColumn, false) // the sweep's reconcile owns this trade now
    assert.match(p.message, /already CLOSED/)
    assert.match(p.message, /Do NOT close it in thinkorswim/)
    assert.match(p.message, /sweep will reconcile/)
  })

  it('a partial fill refuses outright', () => {
    const p = planCancelExit(
      state({ status: 'WORKING', filledQuantity: 1, remainingQuantity: 1 }),
      'before',
    )
    assert.equal(p.outcome, 'refuse')
    assert.equal(p.clearColumn, false)
    assert.match(p.message, /PARTIALLY FILLED/)
    assert.match(p.message, /half-closed/)
  })

  it('a partial fill refuses even when Schwab labels it FILLED', () => {
    // Partial detection wins over the status string — same precedence the
    // sweep uses when deciding whether to journal.
    const p = planCancelExit(
      state({ status: 'FILLED', filledQuantity: 1, remainingQuantity: 1 }),
      'before',
    )
    assert.equal(p.outcome, 'refuse')
  })

  it('an unrecognized status is still cancellable (the operator asked)', () => {
    assert.equal(planCancelExit(state({ status: 'WEIRD' }), 'before').outcome, 'cancel_required')
  })
})

describe('planCancelExit — after the cancel', () => {
  it('confirmed terminal clears the record', () => {
    const p = planCancelExit(state({ status: 'CANCELED' }), 'after')
    assert.equal(p.outcome, 'terminal')
    assert.equal(p.clearColumn, true)
    assert.match(p.message, /cancelled/)
  })

  // PENDING_CANCEL can still fill. Clearing here would let the next sweep
  // place a second GTC against a live order.
  it('PENDING_CANCEL does NOT clear the record', () => {
    const p = planCancelExit(state({ status: 'PENDING_CANCEL' }), 'after')
    assert.equal(p.outcome, 'pending')
    assert.equal(p.clearColumn, false)
    assert.match(p.message, /NOT cleared/)
    assert.match(p.message, /next sweep clears it/)
  })

  it('still WORKING after a cancel does not clear either', () => {
    const p = planCancelExit(state({ status: 'WORKING' }), 'after')
    assert.equal(p.outcome, 'pending')
    assert.equal(p.clearColumn, false)
  })

  it('filled during the cancel round-trip is reported as a closed position', () => {
    const p = planCancelExit(
      state({ status: 'FILLED', filledQuantity: 1, remainingQuantity: 0 }),
      'after',
    )
    assert.equal(p.outcome, 'filled')
    assert.equal(p.clearColumn, false)
  })
})

describe('planCancelExit — clearColumn is never true off a live order', () => {
  it('holds across every non-terminal status', () => {
    const live = [
      'WORKING',
      'ACCEPTED',
      'QUEUED',
      'PENDING_ACTIVATION',
      'PENDING_CANCEL',
      'AWAITING_MANUAL_REVIEW',
      'NEW',
      'UNKNOWN',
      'FILLED',
    ]
    for (const status of live) {
      for (const phase of ['before', 'after'] as const) {
        assert.equal(
          planCancelExit(state({ status, filledQuantity: status === 'FILLED' ? 1 : 0, remainingQuantity: status === 'FILLED' ? 0 : 1 }), phase).clearColumn,
          false,
          `${status}/${phase} must not clear the column`,
        )
      }
    }
  })
})
