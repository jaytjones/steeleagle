// ============================================================
// SteelEagle — v2.15 auto-roll planner
//
// Live payloads wherever they exist: four single-ticket rolls (SPY 08-28 ×2,
// SPY 09-11 CONDOR + CUSTOM), the GLD 2-lot pair, both split-roll halves, the
// SWVXX cash sweep and the cancelled GTC. Every condition row in the module
// header has a test that names it.
// ============================================================

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { planAutoRolls, summarizeAutoRoll, type AutoRollFill, type AutoRollTrade } from './auto-roll'
import { planAutoCloses } from './auto-close'
import { classifyFill, type ClassifiedLeg, type FillClassification } from './classify-fill'
import { structureRefusal } from './current-structure'
import { GOLDEN_FILLS } from './golden-fills.fixture'
import type { Leg } from './types'

const {
  SPY_ROLL_CONDOR,
  SPY_ROLL_CUSTOM,
  SPY_ROLL_0828_FIRST,
  SPY_ROLL_0828_TO_FLY,
  GLD_ROLL_TWO_LOT_FIRST,
  SPY_SPLIT_CLOSE,
  SPY_SPLIT_OPEN,
  SWVXX_CASH_SWEEP,
  SPY_CANCELED_GTC,
} = GOLDEN_FILLS

type Ev = AutoRollTrade['events'][number]
const T0 = '2026-07-20T15:00:00.000Z'
const ev = (
  eventType: Ev['eventType'],
  leg: Leg,
  strike: number,
  expiration: string,
  at = T0,
): Ev => ({ eventType, leg, strike, expiration, occurredAt: at, createdAt: at })

const entry = (exp: string, lp: number, sp: number, sc: number, lc: number, at = T0): Ev[] => [
  ev('open', 'long_put', lp, exp, at),
  ev('open', 'short_put', sp, exp, at),
  ev('open', 'short_call', sc, exp, at),
  ev('open', 'long_call', lc, exp, at),
]

function trade(over: Partial<AutoRollTrade> & Pick<AutoRollTrade, 'events'>): AutoRollTrade {
  return {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    symbol: 'SPY',
    status: 'open',
    currentExpiration: '2026-09-11',
    contracts: 1,
    exitOrderId: null,
    exitHoldOrderId: null,
    ...over,
  }
}

/** The SPY 09-11 condor SPY_ROLL_CONDOR rolls: 700/715 puts, 775/790 calls. */
const spy0911 = (over: Partial<AutoRollTrade> = {}) =>
  trade({ events: entry('2026-09-11', 700, 715, 775, 790), ...over })

/** The SPY 08-28 condor after the morning roll: 720/740 puts, 765/785 calls. */
const spy0828AfterFirst = (over: Partial<AutoRollTrade> = {}) =>
  trade({
    id: 'bbbbbbbb-1111-2222-3333-444444444444',
    currentExpiration: '2026-08-28',
    events: entry('2026-08-28', 720, 740, 765, 785),
    ...over,
  })

// Aug 4 2026, the whole trading day.
const AUG4 = { from: new Date('2026-08-03T21:15:00Z'), to: new Date('2026-08-04T21:15:00Z') }

const row = (c: FillClassification, disposition = 'pending'): AutoRollFill => ({
  classification: c,
  disposition,
})

const plan = (over: Partial<Parameters<typeof planAutoRolls>[0]> = {}) =>
  planAutoRolls({
    fills: [row(classifyFill(SPY_ROLL_CONDOR))],
    trades: [spy0911()],
    interval: AUG4,
    balanceStatus: 'BALANCED',
    ...over,
  })

/** Rewrite one leg of a classification — the synthetic-shape helper. */
function withLegs(c: FillClassification, legs: ClassifiedLeg[]): FillClassification {
  return { ...c, legs }
}

// --------------------------------------------------------

describe('planAutoRolls — G, the shared gate', () => {
  it('a BALANCED interval writes the unambiguous roll, with its events built once', () => {
    const p = plan()
    assert.equal(p.gate, 'OPEN')
    assert.deepEqual(p.refused, [])
    assert.equal(p.write.length, 1)
    const w = p.write[0]
    assert.equal(w.orderId, '1007454721397')
    assert.equal(w.tradeId, spy0911().id)
    assert.equal(w.expiration, '2026-09-11')
    assert.equal(w.contracts, 1)
    assert.deepEqual(
      w.events.map((e) => [e.eventType, e.leg, e.strike, e.price, e.creditDebit]),
      [
        ['roll_close', 'short_put', 715, 2.49, 'debit'],
        ['roll_close', 'long_put', 700, 1.74, 'credit'],
        ['roll_open', 'short_put', 740, 5.05, 'credit'],
        ['roll_open', 'long_put', 725, 3.25, 'debit'],
      ],
    )
  })

  for (const status of ['RESIDUAL', 'UNRELIABLE', 'UNANCHORED', 'balanced', null]) {
    it(`${status ?? 'a null balance'} shuts the gate — nothing is written`, () => {
      const p = plan({ balanceStatus: status })
      assert.equal(p.gate, 'CLOSED')
      assert.equal(p.write.length, 0)
      assert.equal(p.considered, 0)
    })
  }

  it('a null interval shuts the gate', () => {
    const p = plan({ interval: null })
    assert.equal(p.gate, 'CLOSED')
    assert.match(p.gateReason, /no interval/)
  })

  it('the gate reason matches auto-close word for word — one gate, two consumers', () => {
    const args = { fills: [], trades: [], interval: AUG4, balanceStatus: 'RESIDUAL' }
    assert.equal(planAutoRolls(args).gateReason, planAutoCloses(args).gateReason)
  })
})

describe('planAutoRolls — silent skips (1, 2, 3, A, 4=0)', () => {
  it('1 — a DISMISSED or already-JOURNALED disposition is never auto-written', () => {
    for (const d of ['dismissed', 'journaled']) {
      const p = plan({ fills: [row(classifyFill(SPY_ROLL_CONDOR), d)] })
      assert.equal(p.write.length, 0, d)
      assert.equal(p.considered, 0, d)
    }
  })

  it('2 — split-roll halves are never paired, never written', () => {
    const p = plan({
      fills: [row(classifyFill(SPY_SPLIT_CLOSE)), row(classifyFill(SPY_SPLIT_OPEN))],
      interval: { from: new Date('2026-08-13T21:15:00Z'), to: new Date('2026-08-14T21:15:00Z') },
    })
    assert.equal(p.considered, 0)
    assert.equal(p.write.length, 0)
  })

  it('2 — the cancelled GTC and the SWVXX sweep are not candidates, and leave the gate unmoved', () => {
    const p = plan({
      fills: [row(classifyFill(SPY_CANCELED_GTC)), row(classifyFill(SWVXX_CASH_SWEEP)), row(classifyFill(SPY_ROLL_CONDOR))],
    })
    assert.equal(p.gate, 'OPEN')
    assert.equal(p.considered, 1)
    assert.equal(p.write.length, 1)
  })

  it('3 — a roll OUTSIDE the interval is never written, however recent', () => {
    const p = plan({ interval: { from: new Date('2026-08-04T21:15:00Z'), to: new Date('2026-08-05T21:15:00Z') } })
    assert.equal(p.considered, 0)
    assert.equal(p.write.length, 0)
  })

  it('A — a roll JJ already journaled by hand is NOT written twice', () => {
    // The trade stays open after a roll, so closeOwners still finds it via the
    // entry events. Without condition A this would write the roll a second time.
    const at = '2026-08-04T14:39:22.000Z'
    const journaled = spy0911({
      events: [
        ...entry('2026-09-11', 700, 715, 775, 790),
        ev('roll_close', 'short_put', 715, '2026-09-11', at),
        ev('roll_close', 'long_put', 700, '2026-09-11', at),
        ev('roll_open', 'short_put', 740, '2026-09-11', at),
        ev('roll_open', 'long_put', 725, '2026-09-11', at),
      ],
    })
    const p = plan({ trades: [journaled] })
    assert.equal(p.considered, 1)
    assert.equal(p.write.length, 0)
    assert.deepEqual(p.refused, [])
  })

  it('4 — no owning trade is a SKIP, not a refusal', () => {
    const p = plan({ trades: [] })
    assert.equal(p.write.length, 0)
    assert.deepEqual(p.refused, [])
  })

  it('4 — a CLOSED trade does not own the legs', () => {
    const p = plan({ trades: [spy0911({ status: 'closed' })] })
    assert.equal(p.write.length, 0)
    assert.deepEqual(p.refused, [])
  })
})

describe('planAutoRolls — refusals (recorded, the inbox card stays)', () => {
  const gld1 = (id: string) =>
    trade({
      id,
      symbol: 'GLD',
      currentExpiration: '2026-09-18',
      events: entry('2026-09-18', 330, 350, 400, 420),
    })
  const GLD_AUG7 = { from: new Date('2026-08-06T21:15:00Z'), to: new Date('2026-08-07T21:15:00Z') }

  it('4 — TWO same-strike owners REFUSE (GLD 2026-09-18 scale-in, §3.2)', () => {
    const p = plan({
      fills: [row(classifyFill(GLD_ROLL_TWO_LOT_FIRST))],
      trades: [gld1('11111111-aaaa-bbbb-cccc-dddddddddddd'), gld1('22222222-aaaa-bbbb-cccc-dddddddddddd')],
      interval: GLD_AUG7,
    })
    assert.equal(p.write.length, 0)
    assert.equal(p.refused.length, 1)
    assert.equal(p.refused[0].tradeId, null)
    assert.match(p.refused[0].reason, /2 open journal trades.*will not guess/)
  })

  it('5 — a 2-lot ticket against one 1-lot trade REFUSES (aggregated roll)', () => {
    const p = plan({
      fills: [row(classifyFill(GLD_ROLL_TWO_LOT_FIRST))],
      trades: [gld1('11111111-aaaa-bbbb-cccc-dddddddddddd')],
      interval: GLD_AUG7,
    })
    assert.equal(p.write.length, 0)
    assert.match(p.refused[0].reason, /rolled 2 contract\(s\).*holds 1/)
  })

  it('5 — the same 2-lot ticket against ONE 2-lot trade is written', () => {
    const p = plan({
      fills: [row(classifyFill(GLD_ROLL_TWO_LOT_FIRST))],
      trades: [{ ...gld1('11111111-aaaa-bbbb-cccc-dddddddddddd'), contracts: 2 }],
      interval: GLD_AUG7,
    })
    assert.deepEqual(p.refused, [])
    assert.equal(p.write.length, 1)
    assert.equal(p.write[0].contracts, 2)
  })

  it('H — a standing GTC still on record REFUSES (it targets the pre-roll legs)', () => {
    const p = plan({ trades: [spy0911({ exitOrderId: '1007000000001' })] })
    assert.equal(p.write.length, 0)
    assert.match(p.refused[0].reason, /standing GTC 1007000000001.*PRE-ROLL/)
  })

  it('H — an unconfirmed earlier auto-roll REFUSES (the confirm card must keep its order id)', () => {
    const p = plan({ trades: [spy0911({ exitHoldOrderId: '1007000000002' })] })
    assert.equal(p.write.length, 0)
    assert.match(p.refused[0].reason, /awaiting your confirmation.*1007000000002/)
  })

  it('R — two rolls of one trade in one interval: the FIRST is written, the second refuses', () => {
    // The real Aug 4 pair on SPY 08-28, fed in REVERSE order to prove the
    // planner sorts by execution time rather than trusting list order.
    const before = trade({
      id: 'bbbbbbbb-1111-2222-3333-444444444444',
      currentExpiration: '2026-08-28',
      events: entry('2026-08-28', 680, 700, 765, 785),
    })
    const p = plan({
      fills: [row(classifyFill(SPY_ROLL_0828_TO_FLY)), row(classifyFill(SPY_ROLL_0828_FIRST))],
      trades: [before],
    })
    assert.equal(p.write.length, 1)
    assert.equal(p.write[0].orderId, '1007450735138')
    assert.equal(p.refused.length, 1)
    assert.equal(p.refused[0].orderId, '1007465290239')
    assert.match(p.refused[0].reason, /second roll/)
  })

  it('R — a second roll on the OTHER side is refused too, not written on stale state', () => {
    const c = classifyFill(SPY_ROLL_CONDOR)
    const later = '2026-08-04T19:00:00.000Z'
    const callRoll: FillClassification = {
      ...c,
      orderId: '1007000000099',
      occurredAt: later,
      legs: [
        { ...c.legs[0], putCall: 'CALL', action: 'close', role: 'short_call', strike: 775, price: 1.1 },
        { ...c.legs[0], putCall: 'CALL', action: 'close', role: 'long_call', strike: 790, price: 0.4 },
        { ...c.legs[0], putCall: 'CALL', action: 'open', role: 'short_call', strike: 770, price: 1.5 },
        { ...c.legs[0], putCall: 'CALL', action: 'open', role: 'long_call', strike: 785, price: 0.6 },
      ],
    }
    const p = plan({ fills: [row(callRoll), row(c)] })
    assert.deepEqual(p.write.map((w) => w.orderId), ['1007454721397'])
    assert.deepEqual(p.refused.map((r) => r.orderId), ['1007000000099'])
    assert.match(p.refused[0].reason, /second roll/)
  })

  it('6 — a trade whose row says a different expiration REFUSES', () => {
    const p = plan({ trades: [spy0911({ currentExpiration: '2026-09-18' })] })
    assert.equal(p.write.length, 0)
    assert.match(p.refused[0].reason, /only same-expiration/)
  })

  it('6 — a ticket spanning two expirations (a roll out in time) REFUSES', () => {
    const c = classifyFill(SPY_ROLL_CONDOR)
    const out = withLegs(
      { ...c, expiration: null },
      c.legs.map((l) => (l.action === 'open' ? { ...l, expiration: '2026-09-18' } : l)),
    )
    const p = plan({ fills: [row(out)] })
    assert.equal(p.write.length, 0)
    assert.match(p.refused[0].reason, /more than one expiration/)
  })

  it('7 — a 2+2 that mixes puts and calls REFUSES', () => {
    const c = classifyFill(SPY_ROLL_CONDOR)
    // Close SP + LP, reopen SP + LP — but relabel the long put pair as calls.
    const mixed = withLegs(
      c,
      c.legs.map((l) => (l.role === 'long_put' ? { ...l, putCall: 'CALL' as const } : l)),
    )
    const p = plan({ fills: [row(mixed)] })
    assert.equal(p.write.length, 0)
    assert.match(p.refused[0].reason, /mixes puts and calls/)
  })

  it('7 — an orphan close (a partial unwind) REFUSES', () => {
    const c = classifyFill(SPY_ROLL_CONDOR)
    const unwind = withLegs(
      c,
      c.legs.filter((l) => !(l.action === 'open' && l.role === 'long_put')),
    )
    const p = plan({ fills: [row(unwind)] })
    assert.equal(p.write.length, 0)
    assert.match(p.refused[0].reason, /without reopening it/)
  })

  it('8 — a leg with no execution price REFUSES — never a fabricated $0.00', () => {
    const c = classifyFill(SPY_ROLL_CONDOR)
    const unpriced = withLegs(c, c.legs.map((l, i) => (i === 2 ? { ...l, price: null } : l)))
    const p = plan({ fills: [row(unpriced)] })
    assert.equal(p.write.length, 0)
    assert.match(p.refused[0].reason, /no execution price/)
  })

  it('9a — the journal is BEHIND the account: closing legs it does not hold REFUSE', () => {
    // A hand-journaled roll took the puts to 705/720; the account still closed
    // 700/715. closeOwners matches on the entry events; the fold says otherwise.
    const at = '2026-08-01T15:00:00.000Z'
    const drifted = spy0911({
      events: [
        ...entry('2026-09-11', 700, 715, 775, 790),
        ev('roll_close', 'short_put', 715, '2026-09-11', at),
        ev('roll_close', 'long_put', 700, '2026-09-11', at),
        ev('roll_open', 'short_put', 720, '2026-09-11', at),
        ev('roll_open', 'long_put', 705, '2026-09-11', at),
      ],
    })
    const p = plan({ trades: [drifted] })
    assert.equal(p.write.length, 0)
    assert.match(p.refused[0].reason, /closes SP 715 but the journal holds SP 720.*behind the account/)
  })

  it('9a — a journal whose structure cannot be folded REFUSES', () => {
    const broken = spy0911({ events: entry('2026-09-11', 700, 715, 775, 790).slice(0, 3) })
    const p = plan({ trades: [broken] })
    assert.equal(p.write.length, 0)
    assert.match(p.refused[0].reason, /cannot be reconstructed/)
  })

  it('9b — a post-roll CROSSED body (SP > SC) REFUSES', () => {
    const c = classifyFill(SPY_ROLL_CONDOR)
    // Reopen the short put ABOVE the 775 short call.
    const crossed = withLegs(
      c,
      c.legs.map((l) =>
        l.action === 'open' && l.role === 'short_put' ? { ...l, strike: 780 } : l,
      ),
    )
    const p = plan({ fills: [row(crossed)] })
    assert.equal(p.write.length, 0)
    assert.match(p.refused[0].reason, /not be a valid condor or butterfly.*LP < SP <= SC < LC/)
  })
})

describe('planAutoRolls — what is ADMITTED', () => {
  it('§8.4 — the live butterfly-making roll is written (SP == SC passes the <=)', () => {
    const p = plan({
      fills: [row(classifyFill(SPY_ROLL_0828_TO_FLY))],
      trades: [spy0828AfterFirst()],
    })
    assert.deepEqual(p.refused, [])
    assert.equal(p.write.length, 1)
    const opened = p.write[0].events.filter((e) => e.eventType === 'roll_open')
    assert.deepEqual(opened.map((e) => [e.leg, e.strike]), [['short_put', 765], ['long_put', 745]])
  })

  it('the CUSTOM-labelled roll is written exactly like the CONDOR one (F2)', () => {
    const after = '2026-08-04T14:39:22.000Z'
    const rolledOnce = spy0911({
      events: [
        ...entry('2026-09-11', 700, 715, 775, 790),
        ev('roll_close', 'short_put', 715, '2026-09-11', after),
        ev('roll_close', 'long_put', 700, '2026-09-11', after),
        ev('roll_open', 'short_put', 740, '2026-09-11', after),
        ev('roll_open', 'long_put', 725, '2026-09-11', after),
      ],
    })
    const p = plan({
      fills: [row(classifyFill(SPY_ROLL_CUSTOM))],
      trades: [rolledOnce],
      interval: { from: new Date('2026-08-04T21:15:00Z'), to: new Date('2026-08-05T21:15:00Z') },
    })
    assert.deepEqual(p.refused, [])
    assert.equal(p.write.length, 1)
    assert.equal(p.write[0].orderId, '1007483420023')
  })

  it('§8.2 — a full 4+4 roll is admitted', () => {
    const c = classifyFill(SPY_ROLL_CONDOR)
    const callSide: ClassifiedLeg[] = [
      { ...c.legs[0], putCall: 'CALL', action: 'close', role: 'short_call', strike: 775, price: 1.1 },
      { ...c.legs[0], putCall: 'CALL', action: 'close', role: 'long_call', strike: 790, price: 0.4 },
      { ...c.legs[0], putCall: 'CALL', action: 'open', role: 'short_call', strike: 770, price: 1.5 },
      { ...c.legs[0], putCall: 'CALL', action: 'open', role: 'long_call', strike: 785, price: 0.6 },
    ]
    const p = plan({ fills: [row(withLegs(c, [...c.legs, ...callSide]))] })
    assert.deepEqual(p.refused, [])
    assert.equal(p.write.length, 1)
    assert.equal(p.write[0].events.length, 8)
  })

  it('§3.1 — an INDEX roll is journalable even though no GTC could be priced for it', () => {
    const c = classifyFill(SPY_ROLL_CONDOR)
    const spx: FillClassification = {
      ...c,
      underlying: 'SPX',
      legs: c.legs.map((l) => ({ ...l, underlying: 'SPX', root: 'SPXW' })),
    }
    const t = spy0911({ symbol: 'SPX' })
    // The placement gate refuses SPX outright…
    assert.match(structureRefusal('SPX', t.events)!, /multiple OCC roots/)
    // …and the journal gate does not.
    const p = plan({ fills: [row(spx)], trades: [t] })
    assert.deepEqual(p.refused, [])
    assert.equal(p.write.length, 1)
  })

  it('a malformed classification refuses rather than taking down the batch', () => {
    const c = classifyFill(SPY_ROLL_CONDOR)
    const bad = { ...c, legs: null } as unknown as FillClassification
    const p = plan({ fills: [row(bad), row(classifyFill(SPY_ROLL_CONDOR))] })
    assert.equal(p.refused.length, 1)
    assert.match(p.refused[0].reason, /could not evaluate/)
    assert.equal(p.write.length, 1)
  })
})

describe('summarizeAutoRoll — silence and refusal never look alike', () => {
  it('a held gate says why', () => {
    assert.match(summarizeAutoRoll(plan({ balanceStatus: 'RESIDUAL' })), /held: .*RESIDUAL/)
  })
  it('nothing to do reads differently from a write', () => {
    assert.match(summarizeAutoRoll(plan({ trades: [] })), /nothing to do — 1 filled roll/)
    assert.match(summarizeAutoRoll(plan()), /1 roll\(s\) journaled automatically, GTC held/)
  })
  it('a refusal is always named', () => {
    assert.match(summarizeAutoRoll(plan({ trades: [spy0911({ exitOrderId: 'x' })] })), /1 refused/)
  })
})
