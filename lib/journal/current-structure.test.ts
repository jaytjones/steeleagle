/**
 * v2.3 — currentStructure(events). Run with:
 *   npx tsx --test lib/journal/current-structure.test.ts
 *
 * Equivalence with the deleted `exitInputFromOpenEvents` was pinned before
 * removal (identical output on an unrolled log) and now lives as the
 * end-to-end golden test in lib/schwab/exit-ticket.test.ts — the live post-close
 * placement must not change shape the day this ships.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  currentStructure,
  isPriceableStructure,
  structureRefusal,
  type StructureEvent,
} from './current-structure'
import type { Leg } from './types'

const T0 = '2026-06-01T14:30:00.000Z' // entry
const T1 = '2026-07-10T15:00:00.000Z' // first roll
const T2 = '2026-07-20T15:00:00.000Z' // second roll
const EXP = '2026-08-14'
const EXP2 = '2026-09-18'

let seq = 0
function ev(
  eventType: StructureEvent['eventType'],
  leg: Leg,
  strike: number,
  expiration: string,
  occurredAt: string,
): StructureEvent {
  // createdAt increments with insertion so the tiebreak is exercised.
  return { eventType, leg, strike, expiration, occurredAt, createdAt: `2026-06-01T00:00:${String(seq++).padStart(2, '0')}.000Z` }
}

/** A standard 700/720/770/790 entry. */
function entry(expiration = EXP): StructureEvent[] {
  return [
    ev('open', 'long_put', 700, expiration, T0),
    ev('open', 'short_put', 720, expiration, T0),
    ev('open', 'short_call', 770, expiration, T0),
    ev('open', 'long_call', 790, expiration, T0),
  ]
}

describe('currentStructure — unrolled', () => {
  it('returns the entry legs', () => {
    assert.deepEqual(currentStructure('SPY', entry()), {
      symbol: 'SPY',
      root: 'SPY',
      expiration: EXP,
      longPut: { strike: 700 },
      shortPut: { strike: 720 },
      shortCall: { strike: 770 },
      longCall: { strike: 790 },
    })
  })

  it('ignores close events on the log', () => {
    const events = [...entry(), ev('close', 'short_put', 720, EXP, T1)]
    assert.equal(currentStructure('SPY', events).shortPut.strike, 720)
  })

  it('sorts defensively — unordered input gives the same answer', () => {
    const events = entry().reverse()
    assert.equal(currentStructure('SPY', events).longPut.strike, 700)
  })
})

describe('currentStructure — rolls', () => {
  it('applies a one-sided roll and leaves the other side untouched', () => {
    // Put spread rolled down: 700/720 → 680/700. Calls unchanged.
    const events = [
      ...entry(),
      ev('roll_close', 'long_put', 700, EXP, T1),
      ev('roll_close', 'short_put', 720, EXP, T1),
      ev('roll_open', 'long_put', 680, EXP, T1),
      ev('roll_open', 'short_put', 700, EXP, T1),
    ]
    assert.deepEqual(currentStructure('SPY', events), {
      symbol: 'SPY',
      root: 'SPY',
      expiration: EXP,
      longPut: { strike: 680 },
      shortPut: { strike: 700 },
      shortCall: { strike: 770 },
      longCall: { strike: 790 },
    })
  })

  it('applies a full four-leg roll to a new expiration', () => {
    const events = [
      ...entry(),
      ...(['long_put', 'short_put', 'short_call', 'long_call'] as Leg[]).map((l, i) =>
        ev('roll_close', l, [700, 720, 770, 790][i], EXP, T1),
      ),
      ...(['long_put', 'short_put', 'short_call', 'long_call'] as Leg[]).map((l, i) =>
        ev('roll_open', l, [690, 710, 760, 780][i], EXP2, T1),
      ),
    ]
    assert.deepEqual(currentStructure('SPY', events), {
      symbol: 'SPY',
      root: 'SPY',
      expiration: EXP2,
      longPut: { strike: 690 },
      shortPut: { strike: 710 },
      shortCall: { strike: 760 },
      longCall: { strike: 780 },
    })
  })

  // Session 20 — the strikes here used to end at SC 800, ABOVE the 790 long
  // call: a crossed call spread that no exit ticket could ever be built for
  // (buildCondorExitTicket would have thrown on it). The fold semantics under
  // test are last-wins, not the strike values, so the ladder now ends inside
  // the wing. Keep it that way — the ordering check is deliberate.
  it('the LAST roll wins across two sequential rolls', () => {
    const events = [
      ...entry(),
      ev('roll_close', 'short_call', 770, EXP, T1),
      ev('roll_open', 'short_call', 775, EXP, T1),
      ev('roll_close', 'short_call', 775, EXP, T2),
      ev('roll_open', 'short_call', 780, EXP, T2),
    ]
    assert.equal(currentStructure('SPY', events).shortCall.strike, 780)
  })

  // A roll is atomic: RollTradeSchema stamps ONE occurredAt across every leg,
  // so whichever row the operator happened to add first must not matter.
  // Session 20 — rolled to 710, not 700: the long put sits at 700, so the old
  // fixture collapsed the put spread to zero width. Insertion-order
  // insensitivity is what this pins; the strike just has to be a real one.
  it('is insensitive to roll_open/roll_close insertion order within one roll', () => {
    const opened = [
      ...entry(),
      ev('roll_open', 'short_put', 710, EXP, T1), // added FIRST
      ev('roll_close', 'short_put', 720, EXP, T1), // added second
    ]
    assert.equal(currentStructure('SPY', opened).shortPut.strike, 710)
  })
})

describe('currentStructure — refusals', () => {
  it('refuses a leg closed by a roll and never reopened', () => {
    const events = [...entry(), ev('roll_close', 'short_call', 770, EXP, T1)]
    assert.throws(
      () => currentStructure('SPY', events),
      /short_call.*never reopened|no longer a four-leg condor/,
    )
  })

  it('refuses a double roll_close with no intervening reopen', () => {
    const events = [
      ...entry(),
      ev('roll_close', 'short_put', 720, EXP, T1),
      ev('roll_close', 'short_put', 720, EXP, T2),
    ]
    assert.throws(() => currentStructure('SPY', events), /already close|inconsistent/)
  })

  it('refuses fewer than four open events', () => {
    assert.throws(() => currentStructure('SPY', entry().slice(0, 3)), /expected exactly 4 open/)
  })

  it('refuses duplicate open roles', () => {
    const events = [...entry().slice(0, 3), ev('open', 'short_call', 775, EXP, T0)]
    assert.throws(() => currentStructure('SPY', events), /duplicate short_call|exactly once/)
  })

  // v2.3 spec §5.1 — default: refuse. A one-sided roll OUT IN TIME leaves a
  // diagonal, which cannot be expressed by the ticket's single expiration.
  it('refuses legs spanning multiple expirations (diagonal)', () => {
    const events = [
      ...entry(),
      ev('roll_close', 'long_put', 700, EXP, T1),
      ev('roll_close', 'short_put', 720, EXP, T1),
      ev('roll_open', 'long_put', 690, EXP2, T1),
      ev('roll_open', 'short_put', 710, EXP2, T1),
    ]
    assert.throws(() => currentStructure('SPY', events), /multiple expirations|diagonal/)
  })

  it('refuses an entry that already spans expirations', () => {
    const events = [
      ...entry().slice(0, 3),
      ev('open', 'long_call', 790, EXP2, T0),
    ]
    assert.throws(() => currentStructure('SPY', events), /multiple expirations|diagonal/)
  })
})

// --- Session 20 — strike ordering ------------------------------------------
//
// This whole block is new behaviour, and it closes a real divergence. Before
// it, `currentStructure` compared no strikes at all, so a mis-ordered structure
// passed `isPriceableStructure` (green GTC chip on the Monitor, queued by the
// planner) and then threw inside `buildCondorExitTicket` in the placement loop
// — landing in `report.errors` every sweep run while the UI said it was
// covered. These tests pin the refusal at the predicate, where it routes to
// `toFlag` / MANUAL GTC instead.

/** LP 700 / SP 745 / SC 745 / LC 790 — both shorts on one strike. */
function butterfly(expiration = EXP): StructureEvent[] {
  return [
    ev('open', 'long_put', 700, expiration, T0),
    ev('open', 'short_put', 745, expiration, T0),
    ev('open', 'short_call', 745, expiration, T0),
    ev('open', 'long_call', 790, expiration, T0),
  ]
}

describe('currentStructure — iron butterfly (v2.7.1: exit fixture pinned)', () => {
  // v2.7 refused butterflies here as a FIXTURE gate. Discharged 2026-08-04 by
  // orderId 1007469542479 (SPY 745/765/765/785), which Schwab recorded as
  // complexOrderStrategyType "IRON_CONDOR" — see SPY_BUTTERFLY_GOLDEN in
  // lib/schwab/exit-ticket.test.ts. Butterflies are now priceable.
  it('folds a butterfly to its four legs, both shorts on one strike', () => {
    assert.deepEqual(currentStructure('SPY', butterfly()), {
      symbol: 'SPY',
      root: 'SPY',
      expiration: EXP,
      longPut: { strike: 700 },
      shortPut: { strike: 745 },
      shortCall: { strike: 745 },
      longCall: { strike: 790 },
    })
  })

  it('is priceable — the sweep auto-places its 50% GTC', () => {
    assert.equal(isPriceableStructure('SPY', butterfly()), true)
    assert.equal(structureRefusal('SPY', butterfly()), null)
  })

  it('a butterfly created by a ROLL is priceable too — the origin path', () => {
    // Short put rolled up from 720 onto the short call's 770. This is how every
    // real butterfly gets here (April: "they should only occur because of rolls").
    const events = [
      ...entry(),
      ev('roll_close', 'short_put', 720, EXP, T1),
      ev('roll_open', 'short_put', 770, EXP, T1),
    ]
    assert.equal(isPriceableStructure('SPY', events), true)
    assert.equal(currentStructure('SPY', events).shortPut.strike, 770)
  })

  it('a CROSSED body (SP > SC) is still refused — SP must never exceed SC', () => {
    const events = [
      ...entry(),
      ev('roll_close', 'short_put', 720, EXP, T1),
      ev('roll_open', 'short_put', 780, EXP, T1), // above the 770 short call
    ]
    assert.equal(isPriceableStructure('SPY', events), false)
    assert.throws(() => currentStructure('SPY', events), /not ordered LP < SP <= SC < LC/)
  })

  it('a zero-width wing is still refused (LP == SP)', () => {
    const events = [
      ...entry(),
      ev('roll_close', 'short_put', 720, EXP, T1),
      ev('roll_open', 'short_put', 700, EXP, T1), // onto the 700 long put
    ]
    assert.equal(isPriceableStructure('SPY', events), false)
  })

  it('an ordinary condor is unaffected', () => {
    assert.equal(structureRefusal('SPY', entry()), null)
  })
})

describe('isPriceableStructure', () => {
  it('true for an unrolled condor', () => {
    assert.equal(isPriceableStructure('SPY', entry()), true)
  })
  // Session 20 — 710, not 700: the long put is at 700, so the old fixture
  // asserted "priceable" on a zero-width put spread the exit builder would
  // have refused. Same-expiration rolls still auto-place; that is the point.
  it('true for a same-expiration roll — the v2.2 exclusion this lifts', () => {
    const events = [
      ...entry(),
      ev('roll_close', 'short_put', 720, EXP, T1),
      ev('roll_open', 'short_put', 710, EXP, T1),
    ]
    assert.equal(isPriceableStructure('SPY', events), true)
  })
  it('false for a diagonal', () => {
    const events = [
      ...entry(),
      ev('roll_close', 'short_put', 720, EXP, T1),
      ev('roll_open', 'short_put', 710, EXP2, T1),
    ]
    assert.equal(isPriceableStructure('SPY', events), false)
  })
})

// --- v2.4 — symbol-level refusals ------------------------------------------
//
// These are the placement gate for index options. `isPriceableStructure` is
// the ONE predicate the sweep planner and the Monitor's MANUAL GTC chip both
// consume (CLAUDE.md), so a refusal here is simultaneously "the cron will not
// place" and "the Monitor shows MANUAL GTC" — they cannot disagree.

describe('currentStructure — multi-root index refusal (v2.4 §8.3 decision)', () => {
  it('refuses SPX, NDX and RUT — the event log cannot prove which root', () => {
    for (const s of ['SPX', 'NDX', 'RUT']) {
      assert.throws(() => currentStructure(s, entry()), /multiple OCC roots/, s)
      assert.equal(isPriceableStructure(s, entry()), false, s)
    }
  })

  it('the refusal tells the operator to place the GTC manually', () => {
    assert.throws(() => currentStructure('SPX', entry()), /place this GTC manually/)
  })

  it('refuses on a perfectly well-formed log — the cause is the symbol, not the events', () => {
    // Same events that succeed for SPY. Nothing about the log is wrong.
    assert.equal(isPriceableStructure('SPY', entry()), true)
    assert.equal(isPriceableStructure('SPX', entry()), false)
  })
})

describe('currentStructure — unpinned order fixture (Schwab doctrine)', () => {
  it('XSP is now fully priceable — fixture pinned 2026-07-30, single root', () => {
    assert.equal(isPriceableStructure('XSP', entry()), true)
    const s = currentStructure('XSP', entry())
    assert.equal(s.symbol, 'XSP')
    assert.equal(s.root, 'XSP')
  })

  it('a still-unpinned index refuses and names the exact step that lifts it', () => {
    assert.throws(() => currentStructure('NDX', entry()), /no pinned order fixture|multiple OCC roots/)
  })

  it('every ETF stays placeable — the shipped path is untouched', () => {
    for (const s of ['SPY', 'QQQ', 'IWM', 'TLT', 'GLD', 'VXX', 'UUP']) {
      assert.equal(isPriceableStructure(s, entry()), true, s)
    }
  })
})

describe('structureRefusal', () => {
  it('returns null for a priceable trade', () => {
    assert.equal(structureRefusal('SPY', entry()), null)
    assert.equal(structureRefusal('XSP', entry()), null) // pinned 2026-07-30
  })

  it('returns the symbol-level refusal verbatim', () => {
    assert.match(structureRefusal('SPX', entry())!, /multiple OCC roots/)
  })

  it('still returns the event-log refusals it did before', () => {
    const diagonal = [
      ...entry(),
      ev('roll_close', 'short_put', 720, EXP, T1),
      ev('roll_open', 'short_put', 710, EXP2, T1),
    ]
    assert.match(structureRefusal('SPY', diagonal)!, /span multiple expirations/)
  })

  it('agrees with isPriceableStructure on every case', () => {
    const cases: Array<[string, StructureEvent[]]> = [
      ['SPY', entry()],
      ['SPX', entry()],
      ['XSP', entry()],
      ['SPY', entry().slice(0, 3)],
    ]
    for (const [symbol, events] of cases) {
      assert.equal(
        isPriceableStructure(symbol, events),
        structureRefusal(symbol, events) === null,
        symbol,
      )
    }
  })
})

describe('currentStructure — root on the output', () => {
  it('an ETF root equals its symbol', () => {
    assert.equal(currentStructure('SPY', entry()).root, 'SPY')
  })

  it('an off-universe ticker falls back to itself', () => {
    assert.equal(currentStructure('ARKK', entry()).root, 'ARKK')
  })
})
