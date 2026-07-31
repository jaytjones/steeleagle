/**
 * v2.3.1 — pins the roll -> exit_order_id -> sweep chain as UNCHANGED by the
 * roll-form hardening.
 *
 * The hardening (explicit prices, the roll-leg invariant, ActionResult on
 * rollTradeAction) is a schema-and-form change. It must not move a single
 * decision in the exit path. A roll touches an OPEN trade that may carry a
 * standing GTC, so the chain worth pinning is:
 *
 *   rollTrade()          nulls trades.exit_order_id and returns the prior id
 *        |               (lib/db/journal.ts — the warning is the operator's
 *        |                only notice; nulling cancels NOTHING at Schwab)
 *        v
 *   currentStructure()   folds the roll into the trade's live four legs
 *        |               -> isPriceableStructure decides placement eligibility
 *        v
 *   planExitSweep()      exitOrderId null + priceable + dte >= 24 -> re-place
 *
 * These are pure functions, so the whole chain is testable without I/O. The
 * DB write itself (`exit_order_id = NULL`) is asserted by construction here:
 * the post-roll fixture below carries `exitOrderId: null`, which is exactly
 * what rollTrade leaves behind.
 *
 * Run with:  npx tsx --test lib/journal/roll-exit-interaction.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  planExitSweep,
  PLACEMENT_MIN_DTE,
  type SweepTradeInput,
} from '../strategy/exit-sweep'
import { isPriceableStructure, structureRefusal, type StructureEvent } from './current-structure'
import { RollTradeSchema, type Leg } from './types'

const TODAY = new Date('2026-07-30T20:15:00Z')

/** Expiration string exactly `dte` days from TODAY (UTC-midnight convention). */
function expIn(dte: number): string {
  return new Date(Date.UTC(2026, 6, 30) + dte * 86_400_000).toISOString().slice(0, 10)
}

const EXP = expIn(35)
const FAR_EXP = expIn(63)
const T0 = '2026-07-01T14:30:00.000Z'
const T1 = '2026-07-30T15:00:00.000Z'

const STRIKES: Record<Leg, number> = {
  long_put: 700,
  short_put: 720,
  short_call: 770,
  long_call: 790,
}

function ev(
  eventType: StructureEvent['eventType'],
  leg: Leg,
  strike: number,
  expiration: string,
  occurredAt: string,
): StructureEvent {
  return { eventType, leg, strike, expiration, occurredAt, createdAt: occurredAt }
}

/** The four entry legs of a live SPY condor. */
function entry(): StructureEvent[] {
  return (Object.keys(STRIKES) as Leg[]).map((leg) =>
    ev('open', leg, STRIKES[leg], EXP, T0),
  )
}

function trade(overrides: Partial<SweepTradeInput> = {}): SweepTradeInput {
  return {
    id: 't-roll',
    symbol: 'SPY',
    currentExpiration: EXP,
    exitOrderId: null, // what rollTrade leaves behind
    priceable: true,
    ...overrides,
  }
}

describe('roll -> exit_order_id -> sweep (v2.3.1 — must not change)', () => {
  /**
   * The v2.3 ladder, validated live 7/29 -> 7/30: a roll severs the standing
   * exit, and the NEXT sweep re-places against the new structure. This is the
   * behavior the hardening must leave untouched.
   */
  it('a same-expiration roll stays priceable and the sweep re-places', () => {
    const events = [
      ...entry(),
      ev('roll_close', 'short_call', 770, EXP, T1),
      ev('roll_open', 'short_call', 780, EXP, T1),
    ]
    assert.equal(isPriceableStructure('SPY', events), true)

    const plan = planExitSweep([trade({ priceable: true })], [], TODAY)
    assert.deepEqual(plan.toPlace, [{ tradeId: 't-roll', symbol: 'SPY' }])
    assert.equal(plan.toFlag.length, 0)
  })

  it('a roll out in time on ONE side is a diagonal — refused, flagged MANUAL GTC', () => {
    const events = [
      ...entry(),
      ev('roll_close', 'short_call', 770, EXP, T1),
      ev('roll_open', 'short_call', 780, FAR_EXP, T1),
    ]
    const reason = structureRefusal('SPY', events)
    assert.ok(reason && /multiple expirations|diagonal/.test(reason))

    const plan = planExitSweep(
      [trade({ priceable: false, unpriceableReason: reason })],
      [],
      TODAY,
    )
    assert.equal(plan.toPlace.length, 0)
    assert.equal(plan.toFlag.length, 1)
    // The real refusal reaches the operator verbatim, not a generic fallback.
    assert.ok(plan.toFlag[0].reason.includes(reason!))
    assert.match(plan.toFlag[0].reason, /place the GTC manually/)
  })

  /**
   * The case April kept legal on 2026-07-30: an unwind recorded as roll_close
   * legs with no reopen. The schema ACCEPTS it; currentStructure then refuses
   * it downstream and the sweep degrades to a flag. Both halves pinned here so
   * the "allow at entry, refuse at placement" split cannot drift apart.
   */
  it('a one-sided unwind is accepted by the schema but never auto-placed', () => {
    assert.equal(
      RollTradeSchema.safeParse({
        occurredAt: T1,
        newExpiration: null,
        events: [
          { eventType: 'roll_close', leg: 'long_put', strike: 700, expiration: EXP, delta: null, price: 0.05, creditDebit: 'debit' },
          { eventType: 'roll_close', leg: 'short_put', strike: 720, expiration: EXP, delta: null, price: 1.2, creditDebit: 'debit' },
        ],
      }).success,
      true,
    )

    const events = [
      ...entry(),
      ev('roll_close', 'long_put', 700, EXP, T1),
      ev('roll_close', 'short_put', 720, EXP, T1),
    ]
    const reason = structureRefusal('SPY', events)
    assert.ok(reason && /never\s+reopened|no longer a four-leg condor/.test(reason))

    const plan = planExitSweep([trade({ priceable: false, unpriceableReason: reason })], [], TODAY)
    assert.equal(plan.toPlace.length, 0)
    assert.equal(plan.toFlag.length, 1)
  })

  /**
   * Nulling exit_order_id cancels nothing at Schwab (spec §6.4). The sweep must
   * not reconcile or clear against an id the roll has already dropped — the
   * operator cancels the stale GTC in TOS, and rollTradeAction's warning is the
   * only place that id is still visible.
   */
  it('a null exit_order_id makes the sweep skip reconcile and clear entirely', () => {
    const plan = planExitSweep([trade()], [], TODAY)
    assert.deepEqual(plan.toReconcile, [])
    assert.deepEqual(plan.toClear, [])
  })

  it('the 21-DTE alert drops the cancel-GTC clause once the roll nulled the id', () => {
    const near = expIn(20)
    const plan = planExitSweep(
      [trade({ currentExpiration: near, exitOrderId: null })],
      [],
      TODAY,
    )
    assert.equal(plan.toAlert.length, 1)
    assert.match(plan.toAlert[0].message, /close SPY manually/)
    assert.doesNotMatch(plan.toAlert[0].message, /cancel standing GTC/)
  })

  it('the DTE floor still gates re-placement after a roll', () => {
    const belowFloor = planExitSweep(
      [trade({ currentExpiration: expIn(PLACEMENT_MIN_DTE - 1) })],
      [],
      TODAY,
    )
    assert.equal(belowFloor.toPlace.length, 0)

    const atFloor = planExitSweep(
      [trade({ currentExpiration: expIn(PLACEMENT_MIN_DTE) })],
      [],
      TODAY,
    )
    assert.equal(atFloor.toPlace.length, 1)
  })

  /**
   * Fetched-order truth beats the nulled column: if the pre-roll GTC is still
   * WORKING at Schwab because the operator has not cancelled it yet, the
   * pre-place guard must block the re-place rather than stack a second GTC.
   */
  it('a still-working pre-roll GTC blocks re-placement via the pre-place guard', () => {
    const plan = planExitSweep(
      [trade()],
      [
        {
          orderId: '1007409658003',
          status: 'WORKING',
          underlying: 'SPY',
          expiration: EXP,
          isClose: true,
          filledQuantity: null,
          remainingQuantity: null,
        },
      ],
      TODAY,
    )
    assert.equal(plan.toPlace.length, 0)
    assert.equal(plan.toFlag.length, 1)
    assert.match(plan.toFlag[0].reason, /unexpected working close order 1007409658003/)
  })
})
