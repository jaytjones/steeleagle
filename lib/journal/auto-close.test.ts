// ============================================================
// SteelEagle — v2.14 auto-close planner
//
// The live payloads do the talking wherever they can: SPY_BUTTERFLY_CLOSE is a
// real four-leg close, and SPY_CANCELED_GTC is the cancellation that spent six
// days telling JJ to close a trade that was still open.
// ============================================================

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { planAutoCloses, summarizeAutoClose } from './auto-close'
import { classifyFill } from './classify-fill'
import { GOLDEN_FILLS } from './golden-fills.fixture'
import type { MatchTrade } from './match-fill'

const { SPY_BUTTERFLY_CLOSE, SPY_CANCELED_GTC, GLD_ENTRY } = GOLDEN_FILLS

// SPY_BUTTERFLY_CLOSE closes SPY 2026-08-28 at 745/765/765/785, filled
// 2026-08-07. The interval below brackets that execution.
const INTERVAL = {
  from: new Date('2026-08-06T21:15:00Z'),
  to: new Date('2026-08-07T21:15:00Z'),
}

type Ev = MatchTrade['events'][number]
const ev = (eventType: Ev['eventType'], leg: Ev['leg'], strike: number, expiration: string): Ev => ({
  eventType,
  leg,
  strike,
  expiration,
})

const E = '2026-08-28'

/** The trade SPY_BUTTERFLY_CLOSE closes: open at 745/765/765/785. */
function butterflyTrade(over: Partial<MatchTrade> = {}): MatchTrade {
  return {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    symbol: 'SPY',
    status: 'open',
    currentExpiration: E,
    contracts: 1,
    events: [
      ev('open', 'long_put', 745, E),
      ev('open', 'short_put', 765, E),
      ev('open', 'short_call', 765, E),
      ev('open', 'long_call', 785, E),
    ],
    ...over,
  }
}

const plan = (over: Partial<Parameters<typeof planAutoCloses>[0]> = {}) =>
  planAutoCloses({
    fills: [{ classification: classifyFill(SPY_BUTTERFLY_CLOSE), disposition: 'pending' }],
    trades: [butterflyTrade()],
    interval: INTERVAL,
    balanceStatus: 'BALANCED',
    ...over,
  })

// --------------------------------------------------------

describe('planAutoCloses — the gate', () => {
  it('a BALANCED interval with one unambiguous close writes it', () => {
    const p = plan()
    assert.equal(p.gate, 'OPEN')
    assert.equal(p.write.length, 1)
    assert.equal(p.write[0].orderId, '1007514529392')
    assert.equal(p.write[0].tradeId, butterflyTrade().id)
    assert.equal(p.write[0].contracts, 1)
    assert.deepEqual(p.refused, [])
  })

  it('a RESIDUAL interval writes NOTHING — all or nothing, per interval', () => {
    const p = plan({ balanceStatus: 'RESIDUAL' })
    assert.equal(p.gate, 'CLOSED')
    assert.equal(p.write.length, 0)
    assert.match(p.gateReason, /unexplained/)
  })

  it('UNRELIABLE shuts the gate — a refusal is not a zero', () => {
    // The v2.13.1 and v2.13.2 state. An interval carrying any refusal proves
    // nothing, and a proof that proves nothing must not authorise a write.
    assert.equal(plan({ balanceStatus: 'UNRELIABLE' }).gate, 'CLOSED')
  })

  it('UNANCHORED shuts the gate — the first-ever run cannot balance trivially', () => {
    assert.equal(plan({ balanceStatus: 'UNANCHORED' }).gate, 'CLOSED')
  })

  it('a null balance (ingestion threw) shuts the gate', () => {
    const p = plan({ balanceStatus: null })
    assert.equal(p.gate, 'CLOSED')
    assert.match(p.gateReason, /UNKNOWN/)
  })

  it('a null interval shuts the gate', () => {
    const p = plan({ interval: null })
    assert.equal(p.gate, 'CLOSED')
    assert.match(p.gateReason, /no interval/)
  })

  it('an unrecognised status cannot open the gate — BALANCED is a whitelist', () => {
    assert.equal(plan({ balanceStatus: 'PROBABLY_FINE' }).gate, 'CLOSED')
  })
})

describe('planAutoCloses — the interval bound, not the inbox window', () => {
  it('a close OUTSIDE the interval is never written, however recent', () => {
    // Today's proof covers (anchor, now]. A close from an earlier day is a
    // perfectly good inbox card and is not covered by tonight's residual.
    const p = plan({
      interval: { from: new Date('2026-08-08T21:15:00Z'), to: new Date('2026-08-09T21:15:00Z') },
    })
    assert.equal(p.gate, 'OPEN')
    assert.equal(p.considered, 0)
    assert.equal(p.write.length, 0)
  })

  it('the interval is half-open — a fill exactly AT `from` belongs to the prior one', () => {
    const at = new Date(classifyFill(SPY_BUTTERFLY_CLOSE).occurredAt)
    assert.equal(plan({ interval: { from: at, to: INTERVAL.to } }).considered, 0)
    assert.equal(
      plan({ interval: { from: new Date(at.getTime() - 1), to: at } }).considered,
      1,
      'and a fill exactly AT `to` is inside it',
    )
  })
})

describe('planAutoCloses — refusals', () => {
  it('TWO owning trades REFUSES — it will not guess between same-strike condors', () => {
    // Key-collision site (c), the GLD 2026-09-18 shape. Both trades hold the
    // legs; nothing in the fill says which lot closed. matchFill would take the
    // first and show a card. A write must not.
    const a = butterflyTrade({ id: 'aaaaaaaa-1111-2222-3333-444444444444' })
    const b = butterflyTrade({ id: 'bbbbbbbb-1111-2222-3333-444444444444' })
    const p = plan({ trades: [a, b] })

    assert.equal(p.write.length, 0)
    assert.equal(p.refused.length, 1)
    assert.equal(p.refused[0].tradeId, null, 'naming one of them would be the guess')
    assert.match(p.refused[0].reason, /2 open journal trades/)
    assert.match(p.refused[0].reason, /will not guess/)
  })

  it('a CONTRACT MISMATCH refuses — a partial close is never automatic', () => {
    const p = plan({ trades: [butterflyTrade({ contracts: 2 })] })
    assert.equal(p.write.length, 0)
    assert.equal(p.refused.length, 1)
    assert.match(p.refused[0].reason, /closed 1 contract\(s\) but trade .* holds 2/)
  })

  it('a refusal keeps the trade OPEN and unwritten — state is left intact', () => {
    const p = plan({ trades: [butterflyTrade({ contracts: 2 })] })
    assert.deepEqual(p.write, [])
    assert.equal(p.considered, 1, 'it was looked at, and declined — not skipped silently')
  })
})

describe('planAutoCloses — what is not a candidate at all', () => {
  it('a CANCELLATION is never written — the v2.13.2 payload, end to end', () => {
    // Order 1007540494945 read as a filled CONDOR_CLOSE until 2026-08-20. Had
    // auto-write shipped before that fix, this is the fill it would have acted
    // on: a real trade, still open, closed by the app on a phantom.
    const p = plan({ fills: [{ classification: classifyFill(SPY_CANCELED_GTC), disposition: 'pending' }] })
    assert.equal(p.considered, 0)
    assert.deepEqual(p.write, [])
  })

  it('an ENTRY is never written — closes only (JJ, 2026-08-20)', () => {
    const p = plan({ fills: [{ classification: classifyFill(GLD_ENTRY), disposition: 'pending' }] })
    assert.equal(p.considered, 0)
    assert.deepEqual(p.write, [])
  })

  it('no owning trade is a SKIP, not a refusal — it is an inbox question', () => {
    const p = plan({ trades: [] })
    assert.equal(p.considered, 1)
    assert.deepEqual(p.write, [])
    assert.deepEqual(p.refused, [], 'nothing to decline — no trade claims these legs')
  })

  it('a trade already CLOSED does not own the legs — step (a) idempotency', () => {
    // The exit sweep's own reconcile runs first. A trade it just closed falls
    // out here with no special case, because closeOwners only sees open trades.
    const p = plan({ trades: [butterflyTrade({ status: 'closed' })] })
    assert.deepEqual(p.write, [])
    assert.deepEqual(p.refused, [])
  })
})

describe('summarizeAutoClose — silence and refusal never look alike', () => {
  it('a held gate says WHY', () => {
    const s = summarizeAutoClose(plan({ balanceStatus: 'UNRELIABLE' }))
    assert.match(s, /^auto-journal held:/)
    assert.match(s, /UNRELIABLE/)
  })

  it('nothing to do reads differently from nothing attempted', () => {
    assert.match(summarizeAutoClose(plan({ trades: [] })), /nothing to do/)
  })

  it('a refusal is always named in the summary', () => {
    const s = summarizeAutoClose(plan({ trades: [butterflyTrade({ contracts: 2 })] }))
    assert.match(s, /1 refused/)
    assert.match(s, /inbox/)
  })

  it('a write is reported as a write', () => {
    assert.match(summarizeAutoClose(plan()), /1 close\(s\) journaled automatically/)
  })
})

describe('planAutoCloses — the operator\'s judgement outranks the gate', () => {
  it('a DISMISSED fill is never auto-written', () => {
    // JJ looked at the card and decided it needs nothing. An automatic write
    // that overrides that is worse than one that never fires.
    const p = plan({
      fills: [{ classification: classifyFill(SPY_BUTTERFLY_CLOSE), disposition: 'dismissed' }],
    })
    assert.equal(p.considered, 0)
    assert.deepEqual(p.write, [])
  })

  it('an already-JOURNALED fill is never re-written', () => {
    const p = plan({
      fills: [{ classification: classifyFill(SPY_BUTTERFLY_CLOSE), disposition: 'journaled' }],
    })
    assert.deepEqual(p.write, [])
  })
})
