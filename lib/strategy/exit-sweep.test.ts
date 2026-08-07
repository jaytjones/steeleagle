/**
 * Run with:  npx tsx --test lib/strategy/exit-sweep.test.ts
 *
 * Pins every decision in FINAL spec §4.3 + findings 1–3:
 * rolled-trade exclusion, the 23/24 DTE placement boundary, the pre-place
 * guard, id-absent-from-fetch, terminal states, partial fills, and the
 * digest adapter's OCC handling.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  planExitSweep,
  digestOrderForSweep,
  PLACEMENT_MIN_DTE,
  type SweepTradeInput,
  type SweepOrderState,
} from './exit-sweep'
import type { SchwabOrderDetail } from '../schwab/orders'

// Fixed "today" so DTE math is deterministic: 2026-07-24 (UTC).
const TODAY = new Date('2026-07-24T20:15:00Z')

/** Expiration string exactly `dte` days from TODAY (UTC-midnight convention). */
function expIn(dte: number): string {
  const d = new Date(Date.UTC(2026, 6, 24) + dte * 86_400_000)
  return d.toISOString().slice(0, 10)
}

function trade(overrides: Partial<SweepTradeInput> = {}): SweepTradeInput {
  return {
    id: 't-1',
    symbol: 'SPY',
    currentExpiration: expIn(35),
    exitOrderId: null,
    priceable: true,
    ...overrides,
  }
}

function order(overrides: Partial<SweepOrderState> = {}): SweepOrderState {
  return {
    orderId: '9001',
    status: 'WORKING',
    underlying: 'SPY',
    expiration: expIn(35),
    isClose: true,
    filledQuantity: null,
    remainingQuantity: null,
    ...overrides,
  }
}

describe('planExitSweep — empty state (L1 analog)', () => {
  it('no trades, no orders → every bucket empty', () => {
    const plan = planExitSweep([], [], TODAY)
    assert.deepEqual(plan, {
      toReconcile: [],
      toClear: [],
      toAlert: [],
      toPlace: [],
      toFlag: [],
    })
  })
})

describe('planExitSweep — placement (§4.3c)', () => {
  it('open trade, no standing exit, clear guard, dte 35 → place', () => {
    const plan = planExitSweep([trade()], [], TODAY)
    assert.deepEqual(plan.toPlace, [{ tradeId: 't-1', symbol: 'SPY' }])
    assert.equal(plan.toFlag.length, 0)
    assert.equal(plan.toAlert.length, 0)
  })

  it('dte 24 → place (boundary inclusive)', () => {
    assert.equal(PLACEMENT_MIN_DTE, 24)
    const plan = planExitSweep([trade({ currentExpiration: expIn(24) })], [], TODAY)
    assert.equal(plan.toPlace.length, 1)
  })

  it('dte 23 → no place, no alert (Monitor WATCH band owns 22–23)', () => {
    const plan = planExitSweep([trade({ currentExpiration: expIn(23) })], [], TODAY)
    assert.equal(plan.toPlace.length, 0)
    assert.equal(plan.toAlert.length, 0)
    assert.equal(plan.toFlag.length, 0)
  })

  it('dte 21 → alert only, no place', () => {
    const plan = planExitSweep([trade({ currentExpiration: expIn(21) })], [], TODAY)
    assert.equal(plan.toPlace.length, 0)
    assert.equal(plan.toAlert.length, 1)
    assert.match(plan.toAlert[0].message, /close SPY manually$/)
    assert.equal(plan.toAlert[0].dte, 21)
  })

  // v2.3: the gate is "can currentStructure reconstruct it?", not "is it
  // rolled?" — a same-expiration roll now reaches placement.
  it('unreconstructable structure → flag for manual GTC, never place', () => {
    const plan = planExitSweep([trade({ priceable: false })], [], TODAY)
    assert.equal(plan.toPlace.length, 0)
    assert.equal(plan.toFlag.length, 1)
    assert.match(plan.toFlag[0].reason, /cannot be reconstructed from the event log/)
    assert.equal(plan.toFlag[0].orderId, null)
  })

  it('a ROLLED but reconstructable trade IS placed (the v2.2 exclusion lifted)', () => {
    const plan = planExitSweep([trade({ priceable: true })], [], TODAY)
    assert.deepEqual(plan.toPlace, [{ tradeId: 't-1', symbol: 'SPY' }])
    assert.equal(plan.toFlag.length, 0)
  })
})

describe('planExitSweep — pre-place guard (finding 2)', () => {
  it('working close on same underlying+expiration → flag, no place', () => {
    const plan = planExitSweep([trade()], [order()], TODAY)
    assert.equal(plan.toPlace.length, 0)
    assert.equal(plan.toFlag.length, 1)
    assert.match(plan.toFlag[0].reason, /unexpected working close order 9001 on SPY/)
    assert.match(plan.toFlag[0].reason, /backfill exit_order_id/)
  })

  it('working ENTRY order (isClose=false) on same underlying+exp → place proceeds', () => {
    const plan = planExitSweep([trade()], [order({ isClose: false })], TODAY)
    assert.equal(plan.toPlace.length, 1)
    assert.equal(plan.toFlag.length, 0)
  })

  it('working close on a DIFFERENT expiration → place proceeds', () => {
    const plan = planExitSweep([trade()], [order({ expiration: expIn(63) })], TODAY)
    assert.equal(plan.toPlace.length, 1)
  })

  it('working close on a different underlying → place proceeds', () => {
    const plan = planExitSweep([trade()], [order({ underlying: 'TLT' })], TODAY)
    assert.equal(plan.toPlace.length, 1)
  })

  it('terminal (CANCELED) close on same underlying+exp does NOT block', () => {
    const plan = planExitSweep([trade()], [order({ status: 'CANCELED' })], TODAY)
    assert.equal(plan.toPlace.length, 1)
  })

  it('fully FILLED close does NOT block (already done, reconcile path owns it)', () => {
    const plan = planExitSweep(
      [trade()],
      [order({ status: 'FILLED', filledQuantity: 1, remainingQuantity: 0 })],
      TODAY,
    )
    assert.equal(plan.toPlace.length, 1)
  })

  it('UNRECOGNIZED status close blocks placement (fail safe)', () => {
    const plan = planExitSweep([trade()], [order({ status: 'SOMETHING_NEW' })], TODAY)
    assert.equal(plan.toPlace.length, 0)
    assert.equal(plan.toFlag.length, 1)
  })

  it('order with null underlying (unparseable legs) never matches the guard', () => {
    const plan = planExitSweep(
      [trade()],
      [order({ underlying: null, expiration: null })],
      TODAY,
    )
    assert.equal(plan.toPlace.length, 1)
  })
})

describe('planExitSweep — reconcile (§4.3a)', () => {
  const withExit = (over: Partial<SweepTradeInput> = {}) =>
    trade({ exitOrderId: '9001', ...over })

  it('FILLED clean → reconcile, nothing else', () => {
    const plan = planExitSweep(
      [withExit()],
      [order({ status: 'FILLED', filledQuantity: 1, remainingQuantity: 0 })],
      TODAY,
    )
    assert.deepEqual(plan.toReconcile, [{ tradeId: 't-1', orderId: '9001' }])
    assert.equal(plan.toClear.length, 0)
    assert.equal(plan.toFlag.length, 0)
    assert.equal(plan.toPlace.length, 0) // id set — placement branch never runs
  })

  it('terminal (CANCELED) → clear; NO same-run placement (re-place next sweep)', () => {
    const plan = planExitSweep([withExit()], [order({ status: 'CANCELED' })], TODAY)
    assert.equal(plan.toClear.length, 1)
    assert.match(plan.toClear[0].reason, /CANCELED at Schwab — cleared; next sweep re-places/)
    assert.equal(plan.toPlace.length, 0)
  })

  it('WORKING → steady state, all buckets empty', () => {
    const plan = planExitSweep([withExit()], [order({ status: 'WORKING' })], TODAY)
    assert.deepEqual(plan, {
      toReconcile: [],
      toClear: [],
      toAlert: [],
      toPlace: [],
      toFlag: [],
    })
  })

  it('id absent from fetched set → flag + KEEP id (never null on fetch gap, §6.4)', () => {
    const plan = planExitSweep([withExit()], [], TODAY)
    assert.equal(plan.toClear.length, 0)
    assert.equal(plan.toFlag.length, 1)
    assert.match(plan.toFlag[0].reason, /not found in fetched orders — verify in TOS/)
  })

  it('partial fill → flag only, journal nothing, keep id (§5.5)', () => {
    const plan = planExitSweep(
      [withExit()],
      [order({ status: 'WORKING', filledQuantity: 1, remainingQuantity: 1 })],
      TODAY,
    )
    assert.equal(plan.toReconcile.length, 0)
    assert.equal(plan.toClear.length, 0)
    assert.equal(plan.toFlag.length, 1)
    assert.match(plan.toFlag[0].reason, /partially filled \(1 filled \/ 1 remaining\)/)
  })

  it('partial detection wins even when status says FILLED', () => {
    const plan = planExitSweep(
      [withExit()],
      [order({ status: 'FILLED', filledQuantity: 1, remainingQuantity: 1 })],
      TODAY,
    )
    assert.equal(plan.toReconcile.length, 0)
    assert.equal(plan.toFlag.length, 1)
  })

  it('unrecognized status on own exit order → flag, keep id', () => {
    const plan = planExitSweep([withExit()], [order({ status: 'MYSTERY' })], TODAY)
    assert.equal(plan.toFlag.length, 1)
    assert.match(plan.toFlag[0].reason, /unrecognized status "MYSTERY"/)
  })
})

describe('planExitSweep — 21-DTE alert (§4.3b)', () => {
  it('dte 21 with standing GTC → alert names the id to cancel', () => {
    const plan = planExitSweep(
      [trade({ exitOrderId: '9001', currentExpiration: expIn(21) })],
      [order({ status: 'WORKING' })],
      TODAY,
    )
    assert.equal(plan.toAlert.length, 1)
    assert.match(plan.toAlert[0].message, /cancel standing GTC 9001/)
  })

  it('dte 0 (expiration day) still alerts', () => {
    const plan = planExitSweep([trade({ currentExpiration: expIn(0) })], [], TODAY)
    assert.equal(plan.toAlert.length, 1)
    assert.equal(plan.toAlert[0].dte, 0)
  })
})

describe('planExitSweep — multi-trade independence (per-item isolation shape)', () => {
  it('one rolled + one placeable + one reconcilable coexist correctly', () => {
    const trades = [
      trade({ id: 't-rolled', symbol: 'GLD', priceable: false }),
      trade({ id: 't-place', symbol: 'TLT', currentExpiration: expIn(40) }),
      trade({
        id: 't-filled',
        symbol: 'UUP',
        exitOrderId: '7777',
        currentExpiration: expIn(30),
      }),
    ]
    const orders = [
      order({
        orderId: '7777',
        underlying: 'UUP',
        expiration: expIn(30),
        status: 'FILLED',
        filledQuantity: 1,
        remainingQuantity: 0,
      }),
    ]
    const plan = planExitSweep(trades, orders, TODAY)
    assert.deepEqual(plan.toPlace, [{ tradeId: 't-place', symbol: 'TLT' }])
    assert.deepEqual(plan.toReconcile, [{ tradeId: 't-filled', orderId: '7777' }])
    assert.equal(plan.toFlag.length, 1)
    assert.equal(plan.toFlag[0].tradeId, 't-rolled')
  })
})

describe('digestOrderForSweep', () => {
  const occ = (u: string, ymd: string, cp: 'C' | 'P', strike: number) =>
    `${u.padEnd(6)}${ymd}${cp}${String(Math.round(strike * 1000)).padStart(8, '0')}`

  function rawOrder(overrides: Partial<SchwabOrderDetail> = {}): SchwabOrderDetail {
    return {
      orderId: 9001,
      enteredTime: '2026-07-24T14:00:00Z',
      status: 'WORKING',
      orderLegCollection: [
        { instrument: { symbol: occ('SPY', '260828', 'P', 560) }, instruction: 'SELL_TO_CLOSE', quantity: 1 },
        { instrument: { symbol: occ('SPY', '260828', 'P', 590) }, instruction: 'BUY_TO_CLOSE', quantity: 1 },
        { instrument: { symbol: occ('SPY', '260828', 'C', 660) }, instruction: 'BUY_TO_CLOSE', quantity: 1 },
        { instrument: { symbol: occ('SPY', '260828', 'C', 690) }, instruction: 'SELL_TO_CLOSE', quantity: 1 },
      ],
      ...overrides,
    }
  }

  it('coherent 4-leg close → underlying/expiration extracted, isClose true', () => {
    const d = digestOrderForSweep(rawOrder())
    assert.equal(d.orderId, '9001')
    assert.equal(d.underlying, 'SPY')
    assert.equal(d.expiration, '2026-08-28')
    assert.equal(d.isClose, true)
  })

  it('any *_TO_OPEN leg → isClose false', () => {
    const raw = rawOrder()
    raw.orderLegCollection![0].instruction = 'SELL_TO_OPEN'
    assert.equal(digestOrderForSweep(raw).isClose, false)
  })

  it('mixed expirations (calendar-ish) → underlying/expiration null', () => {
    const raw = rawOrder()
    raw.orderLegCollection![3].instrument.symbol = occ('SPY', '260918', 'C', 690)
    const d = digestOrderForSweep(raw)
    assert.equal(d.underlying, null)
    assert.equal(d.expiration, null)
  })

  it('unparseable leg symbol → underlying null (guard disabled, id matching intact)', () => {
    const raw = rawOrder()
    raw.orderLegCollection![0].instrument.symbol = 'NOT-AN-OCC'
    const d = digestOrderForSweep(raw)
    assert.equal(d.underlying, null)
    assert.equal(d.orderId, '9001')
  })

  it('no legs at all → not a close, no underlying', () => {
    const d = digestOrderForSweep(rawOrder({ orderLegCollection: [] }))
    assert.equal(d.isClose, false)
    assert.equal(d.underlying, null)
  })

  it('missing status → UNKNOWN (which blocks placement downstream)', () => {
    const d = digestOrderForSweep(rawOrder({ status: undefined }))
    assert.equal(d.status, 'UNKNOWN')
  })

  it('fill quantities pass through; absent → null', () => {
    const d1 = digestOrderForSweep(rawOrder({ filledQuantity: 1, remainingQuantity: 1 }))
    assert.equal(d1.filledQuantity, 1)
    assert.equal(d1.remainingQuantity, 1)
    const d2 = digestOrderForSweep(rawOrder())
    assert.equal(d2.filledQuantity, null)
  })
})

// --- v2.4 §5 / §11.1: the root blind spot in the pre-place guard -------------
//
// The highest-severity consumer of the root mapping. The guard keys on
// underlying + expiration on BOTH sides — fetched Schwab orders and journal
// trades. Before v2.4, a working SPXW close did not match a journal trade
// stored as 'SPX', so the guard saw no conflict and the sweep placed a SECOND
// GTC on a position that already had one. Real money, silently duplicated.

describe('pre-place guard resolves roots on both sides (§11.1)', () => {
  const occ = (u: string, ymd: string, cp: 'C' | 'P', strike: number) =>
    `${u.padEnd(6)}${ymd}${cp}${String(Math.round(strike * 1000)).padStart(8, '0')}`

  const ymd = (iso: string) => iso.slice(2).replace(/-/g, '')

  function closeOrder(root: string, exp: string, orderId = '9500'): SweepOrderState {
    return digestOrderForSweep({
      orderId: Number(orderId),
      enteredTime: '2026-07-24T14:00:00Z',
      status: 'WORKING',
      orderLegCollection: [
        { instrument: { symbol: occ(root, ymd(exp), 'P', 6500) }, instruction: 'SELL_TO_CLOSE', quantity: 1 },
        { instrument: { symbol: occ(root, ymd(exp), 'P', 6600) }, instruction: 'BUY_TO_CLOSE', quantity: 1 },
        { instrument: { symbol: occ(root, ymd(exp), 'C', 7800) }, instruction: 'BUY_TO_CLOSE', quantity: 1 },
        { instrument: { symbol: occ(root, ymd(exp), 'C', 7900) }, instruction: 'SELL_TO_CLOSE', quantity: 1 },
      ],
    })
  }

  it('digests an SPXW-legged order to underlying SPX', () => {
    const d = closeOrder('SPXW', expIn(35))
    assert.equal(d.underlying, 'SPX')
    assert.equal(d.isClose, true)
  })

  it('digests a MIXED SPXW + SPX order as coherent, not null', () => {
    // Pre-v2.4 the roots differed leg-to-leg → coherent=false → underlying null
    // → the guard could not match this order to ANY trade.
    const exp = expIn(35)
    const d = digestOrderForSweep({
      orderId: 9600,
      enteredTime: '2026-07-24T14:00:00Z',
      status: 'WORKING',
      orderLegCollection: [
        { instrument: { symbol: occ('SPXW', ymd(exp), 'P', 6500) }, instruction: 'SELL_TO_CLOSE', quantity: 1 },
        { instrument: { symbol: occ('SPX', ymd(exp), 'P', 6600) }, instruction: 'BUY_TO_CLOSE', quantity: 1 },
        { instrument: { symbol: occ('SPXW', ymd(exp), 'C', 7800) }, instruction: 'BUY_TO_CLOSE', quantity: 1 },
        { instrument: { symbol: occ('SPX', ymd(exp), 'C', 7900) }, instruction: 'SELL_TO_CLOSE', quantity: 1 },
      ],
    })
    assert.equal(d.underlying, 'SPX')
    assert.equal(d.expiration, exp)
  })

  it('still refuses to key an order whose legs span genuinely different underlyings', () => {
    const exp = expIn(35)
    const d = digestOrderForSweep({
      orderId: 9700,
      enteredTime: '2026-07-24T14:00:00Z',
      status: 'WORKING',
      orderLegCollection: [
        { instrument: { symbol: occ('SPXW', ymd(exp), 'P', 6500) }, instruction: 'SELL_TO_CLOSE', quantity: 1 },
        { instrument: { symbol: occ('NDXP', ymd(exp), 'P', 6600) }, instruction: 'BUY_TO_CLOSE', quantity: 1 },
      ],
    })
    assert.equal(d.underlying, null)
    assert.equal(d.expiration, null)
  })

  it('a working SPXW close BLOCKS placement for a journal trade stored as SPX', () => {
    const exp = expIn(35)
    const plan = planExitSweep(
      [trade({ id: 't-spx', symbol: 'SPX', currentExpiration: exp })],
      [closeOrder('SPXW', exp)],
      TODAY,
    )
    assert.equal(plan.toPlace.length, 0, 'duplicate GTC would have been placed')
    assert.equal(plan.toFlag.length, 1)
    assert.match(plan.toFlag[0].reason, /unexpected working close order 9500 on SPX/)
  })

  it('an SPXW close on a DIFFERENT expiration does not block', () => {
    const plan = planExitSweep(
      [trade({ id: 't-spx', symbol: 'SPX', currentExpiration: expIn(35) })],
      [closeOrder('SPXW', expIn(63))],
      TODAY,
    )
    assert.deepEqual(plan.toPlace, [{ tradeId: 't-spx', symbol: 'SPX' }])
  })

  it('a working XSP close blocks an XSP trade — the single-root path', () => {
    const exp = expIn(35)
    const plan = planExitSweep(
      [trade({ id: 't-xsp', symbol: 'XSP', currentExpiration: exp })],
      [closeOrder('XSP', exp, '9800')],
      TODAY,
    )
    assert.equal(plan.toPlace.length, 0)
    assert.match(plan.toFlag[0].reason, /working close order 9800 on XSP/)
  })
})

// --- v2.4: the refusal reason reaches the operator verbatim ------------------

describe('unpriceable flag carries the real reason', () => {
  it('uses the supplied refusal message when present', () => {
    const plan = planExitSweep(
      [trade({ symbol: 'SPX', priceable: false, unpriceableReason: 'SPX trades under multiple OCC roots' })],
      [],
      TODAY,
    )
    assert.equal(plan.toPlace.length, 0)
    assert.match(plan.toFlag[0].reason, /SPX — SPX trades under multiple OCC roots/)
    assert.match(plan.toFlag[0].reason, /place the GTC manually at 50% of current net credit/)
  })

  it('falls back to the generic wording when no reason is supplied', () => {
    const plan = planExitSweep([trade({ priceable: false })], [], TODAY)
    assert.match(plan.toFlag[0].reason, /cannot be reconstructed from the event log/)
  })
})

// --- v2.9: flag severity, stamped at the branch that produced it -------------
//
// The dashboard banner reads `severity`, never the reason prose. The split
// that matters is inside the unpriceable branch: a permanent symbol-level
// refusal recurs every run by design and must not hold the banner red, while
// a STRUCTURAL refusal is the v2.7 defect class (before v2.7 it produced
// report.errors every sweep, forever, with no exit placed) and must not be
// demoted to routine alongside it.

describe('v2.9 — flag severity', () => {
  it('a multi-root index refusal is ROUTINE — permanent and decided (v2.4)', () => {
    const plan = planExitSweep(
      [trade({ symbol: 'SPX', priceable: false, unpriceableReason: 'multiple OCC roots' })],
      [],
      TODAY,
    )
    assert.equal(plan.toFlag[0].severity, 'routine')
  })

  it('an unpinned-fixture index refusal is ROUTINE', () => {
    const plan = planExitSweep(
      [trade({ symbol: 'NDX', priceable: false, unpriceableReason: 'order fixture not pinned' })],
      [],
      TODAY,
    )
    assert.equal(plan.toFlag[0].severity, 'routine')
  })

  it('a STRUCTURAL refusal on a placeable symbol is CRITICAL, not routine', () => {
    // SPY: single root, fixture pinned. So the refusal is about the event log —
    // a diagonal, a vacant leg, or strikes not ordered LP < SP <= SC < LC.
    const plan = planExitSweep(
      [
        trade({
          symbol: 'SPY',
          priceable: false,
          unpriceableReason: 'strikes 725 / 740 / 775 / 700 are not ordered LP < SP <= SC < LC',
        }),
      ],
      [],
      TODAY,
    )
    assert.equal(plan.toFlag[0].severity, 'critical')
  })

  it('an unexpected working close order is CRITICAL', () => {
    const plan = planExitSweep([trade()], [order({ orderId: '9800' })], TODAY)
    assert.match(plan.toFlag[0].reason, /unexpected working close order 9800/)
    assert.equal(plan.toFlag[0].severity, 'critical')
  })

  it('a vanished standing GTC is CRITICAL — fetch gap or dead order, both need eyes', () => {
    const plan = planExitSweep([trade({ exitOrderId: '5555' })], [], TODAY)
    assert.match(plan.toFlag[0].reason, /not found in fetched orders/)
    assert.equal(plan.toFlag[0].severity, 'critical')
  })

  it('every flag carries a severity — none may be undefined', () => {
    const plan = planExitSweep(
      [
        trade({ id: 'a', symbol: 'SPX', priceable: false }),
        trade({ id: 'b', symbol: 'SPY', exitOrderId: '5555' }),
        trade({ id: 'c', symbol: 'SPY', priceable: false }),
      ],
      [],
      TODAY,
    )
    assert.equal(plan.toFlag.length, 3)
    for (const f of plan.toFlag) {
      assert.ok(f.severity === 'critical' || f.severity === 'routine', `bad severity: ${f.severity}`)
    }
    // And the mix is genuinely mixed — the whole point of the field.
    assert.equal(plan.toFlag.filter((f) => f.severity === 'routine').length, 1)
    assert.equal(plan.toFlag.filter((f) => f.severity === 'critical').length, 2)
  })
})
