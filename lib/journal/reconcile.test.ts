/**
 * Run with:  npx tsx --test lib/journal/reconcile.test.ts
 *
 * v2.8 journal ⇄ account reconciliation. The anchor test is the REAL
 * 2026-08-04 incident: SPY 2026-08-28 rolled 720/740 → 745/765 (into an iron
 * butterfly) with the roll never journaled. Everything else here exists to
 * keep that detection honest — especially the cases where the answer must be
 * "I cannot tell" rather than a confident MATCH.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  reconcileJournal,
  summarizeReconciliation,
  formatStrikes,
  type ReconcilePosition,
  type ReconcileTrade,
} from './reconcile'
import type { StructureEvent } from './current-structure'
import type { Leg } from './types'

const NOW = new Date('2026-08-05T01:00:00Z')
const T0 = '2026-06-01T14:30:00.000Z'
const T1 = '2026-07-10T15:00:00.000Z'

let seq = 0
function ev(
  eventType: StructureEvent['eventType'],
  leg: Leg,
  strike: number,
  expiration: string,
  occurredAt: string,
): StructureEvent {
  return {
    eventType,
    leg,
    strike,
    expiration,
    occurredAt,
    createdAt: `2026-06-01T00:00:${String(seq++).padStart(2, '0')}.000Z`,
  }
}

function openEvents(
  [lp, sp, sc, lc]: [number, number, number, number],
  expiration: string,
): StructureEvent[] {
  return [
    ev('open', 'long_put', lp, expiration, T0),
    ev('open', 'short_put', sp, expiration, T0),
    ev('open', 'short_call', sc, expiration, T0),
    ev('open', 'long_call', lc, expiration, T0),
  ]
}

function trade(
  over: Partial<ReconcileTrade> & { strikes?: [number, number, number, number] } = {},
): ReconcileTrade {
  const expiration = over.currentExpiration ?? '2026-08-28'
  return {
    id: over.id ?? 'trade-1',
    symbol: over.symbol ?? 'SPY',
    currentExpiration: expiration,
    contracts: over.contracts ?? 1,
    events: over.events ?? openEvents(over.strikes ?? [720, 740, 765, 785], expiration),
  }
}

function condorPosition(
  [lp, sp, sc, lc]: [number, number, number, number],
  over: Partial<ReconcilePosition> = {},
): ReconcilePosition {
  return {
    kind: 'IRON_CONDOR',
    underlying: 'SPY',
    expiration: '2026-08-28',
    quantity: 1,
    legs: [
      { role: 'LONG_PUT', strike: lp },
      { role: 'SHORT_PUT', strike: sp },
      { role: 'SHORT_CALL', strike: sc },
      { role: 'LONG_CALL', strike: lc },
    ],
    ...over,
  }
}

// --------------------------------------------------------
describe('reconcileJournal — the 2026-08-04 incident', () => {
  it('DRIFTs on the unjournaled roll into a butterfly (SPY 2026-08-28)', () => {
    // Journal still reads the pre-roll condor; the account holds the butterfly.
    const [f] = reconcileJournal(
      [trade({ strikes: [720, 740, 765, 785] })],
      [condorPosition([745, 765, 765, 785])],
      NOW,
    )
    assert.equal(f.status, 'DRIFT')
    assert.equal(f.severity, 'critical')
    assert.equal(formatStrikes(f.journalStrikes), '720 / 740 / 765 / 785')
    assert.equal(formatStrikes(f.accountStrikes), '745 / 765 / 765 / 785')
  })

  it('names the actual hazard: the sweep would OPEN a position, not close one', () => {
    const [f] = reconcileJournal(
      [trade({ strikes: [720, 740, 765, 785] })],
      [condorPosition([745, 765, 765, 785])],
      NOW,
    )
    assert.match(f.detail, /OPEN a position/)
    assert.match(f.detail, /unjournaled roll/i)
  })

  it('MATCHes once the roll is journaled — the fix must actually clear it', () => {
    const rolled = trade({
      events: [
        ...openEvents([720, 740, 765, 785], '2026-08-28'),
        ev('roll_close', 'long_put', 720, '2026-08-28', T1),
        ev('roll_close', 'short_put', 740, '2026-08-28', T1),
        ev('roll_open', 'long_put', 745, '2026-08-28', T1),
        ev('roll_open', 'short_put', 765, '2026-08-28', T1),
      ],
    })
    const [f] = reconcileJournal([rolled], [condorPosition([745, 765, 765, 785])], NOW)
    assert.equal(f.status, 'MATCH')
    assert.equal(f.severity, 'ok')
  })
})

describe('reconcileJournal — MATCH', () => {
  it('a clean condor matches', () => {
    const [f] = reconcileJournal(
      [trade({ strikes: [720, 740, 765, 785] })],
      [condorPosition([720, 740, 765, 785])],
      NOW,
    )
    assert.equal(f.status, 'MATCH')
  })

  it('a butterfly matches a butterfly — equal shorts are not a mismatch', () => {
    const [f] = reconcileJournal(
      [trade({ strikes: [745, 765, 765, 785] })],
      [condorPosition([745, 765, 765, 785])],
      NOW,
    )
    assert.equal(f.status, 'MATCH')
  })

  it('multi-contract matches when the counts agree', () => {
    const [f] = reconcileJournal(
      [trade({ strikes: [720, 740, 765, 785], contracts: 3 })],
      [condorPosition([720, 740, 765, 785], { quantity: 3 })],
      NOW,
    )
    assert.equal(f.status, 'MATCH')
  })
})

describe('reconcileJournal — DRIFT', () => {
  it('catches a single changed strike', () => {
    const [f] = reconcileJournal(
      [trade({ strikes: [720, 740, 765, 785] })],
      [condorPosition([720, 740, 765, 790])],
      NOW,
    )
    assert.equal(f.status, 'DRIFT')
  })

  it('catches a contract-count mismatch even when strikes agree', () => {
    // A partial close: 2 of 3 contracts closed in TOS, nothing journaled.
    const [f] = reconcileJournal(
      [trade({ strikes: [720, 740, 765, 785], contracts: 3 })],
      [condorPosition([720, 740, 765, 785], { quantity: 1 })],
      NOW,
    )
    assert.equal(f.status, 'DRIFT')
    assert.match(f.detail, /contracts differ — journal 3, account 1/)
  })

  // Found on the FIRST live run: GLD 2026-09-18, journal 1 vs account 2, with a
  // sweep-placed 1-contract GTC standing against it. The two mismatch kinds fail
  // differently and must not share one explanation.
  it('a contracts-only DRIFT does NOT blame an unjournaled roll', () => {
    const [f] = reconcileJournal(
      [trade({ symbol: 'GLD', strikes: [330, 350, 400, 420], contracts: 1 })],
      [condorPosition([330, 350, 400, 420], { underlying: 'GLD', quantity: 2 })],
      NOW,
    )
    assert.equal(f.status, 'DRIFT')
    assert.doesNotMatch(f.detail, /unjournaled roll/i)
    assert.doesNotMatch(f.detail, /OPEN a position/)
  })

  it('a contracts-only DRIFT spells out the disappearing-remainder failure', () => {
    // Nothing else in the system says this, so the finding has to.
    const [f] = reconcileJournal(
      [trade({ symbol: 'GLD', strikes: [330, 350, 400, 420], contracts: 1 })],
      [condorPosition([330, 350, 400, 420], { underlying: 'GLD', quantity: 2 })],
      NOW,
    )
    assert.match(f.detail, /close only 1 of 2 contracts/)
    assert.match(f.detail, /FULL close/)
    assert.match(f.detail, /invisible to the app/)
  })

  // The real GLD 2026-09-18 case: TWO separate 1-lot condors at IDENTICAL
  // strikes, opened on different days. Schwab aggregates identical-strike
  // positions into one row at the summed quantity, so this is indistinguishable
  // from a single 2-lot — the finding must offer both causes rather than assert
  // the wrong one. (Only DIFFERING strikes give 8 legs → OTHER.)
  it('offers BOTH causes for a contracts-only DRIFT, and warns about the key collision', () => {
    const [f] = reconcileJournal(
      [trade({ symbol: 'GLD', strikes: [330, 350, 400, 420], contracts: 1 })],
      [condorPosition([330, 350, 400, 420], { underlying: 'GLD', quantity: 2 })],
      NOW,
    )
    assert.match(f.detail, /SECOND condor at identical strikes/)
    assert.match(f.detail, /unjournaled size change/)
    assert.match(f.detail, /collide on underlying\+expiration/)
  })

  it('a strike DRIFT still names the roll as the likely cause', () => {
    const [f] = reconcileJournal(
      [trade({ strikes: [720, 740, 765, 785] })],
      [condorPosition([745, 765, 765, 785])],
      NOW,
    )
    assert.match(f.detail, /unjournaled roll/i)
  })

  it('reports BOTH causes when strikes and contracts differ', () => {
    const [f] = reconcileJournal(
      [trade({ strikes: [720, 740, 765, 785], contracts: 2 })],
      [condorPosition([745, 765, 765, 785], { quantity: 1 })],
      NOW,
    )
    assert.match(f.detail, /strikes differ/)
    assert.match(f.detail, /contracts differ/)
  })
})

describe('reconcileJournal — PHANTOM', () => {
  it('is CRITICAL for an unexpired trade with no position', () => {
    const [f] = reconcileJournal([trade({ strikes: [720, 740, 765, 785] })], [], NOW)
    assert.equal(f.status, 'PHANTOM')
    assert.equal(f.severity, 'critical')
    assert.match(f.detail, /OPENS a position instead of closing/)
  })

  it('downgrades to a bookkeeping warning once the expiration has passed', () => {
    // Placement is impossible below 24 DTE, so an expired phantom cannot cause
    // a bad order — it is a Record Close reminder, not a live hazard.
    const expired = trade({ currentExpiration: '2026-07-17', strikes: [700, 720, 770, 790] })
    const [f] = reconcileJournal([expired], [], NOW)
    assert.equal(f.status, 'PHANTOM')
    assert.equal(f.severity, 'warning')
    assert.match(f.detail, /Record Close/)
  })

  it('a position under a DIFFERENT expiration does not rescue the match', () => {
    const [f] = reconcileJournal(
      [trade({ strikes: [720, 740, 765, 785] })],
      [condorPosition([720, 740, 765, 785], { expiration: '2026-09-18' })],
      NOW,
    )
    assert.equal(f.status, 'PHANTOM')
  })
})

describe('reconcileJournal — UNCOMPARABLE (never a silent pass)', () => {
  it('refuses when the journal structure cannot be derived (multi-root index)', () => {
    // SPX trades under SPX/SPXW and the event log records no root, so
    // currentStructure refuses. There is no journal-side structure to compare.
    const spx = trade({ symbol: 'SPX', strikes: [6400, 6500, 6800, 6900] })
    const [f] = reconcileJournal(
      [spx],
      [condorPosition([6400, 6500, 6800, 6900], { underlying: 'SPX' })],
      NOW,
    )
    assert.equal(f.status, 'UNCOMPARABLE')
    assert.match(f.detail, /multiple OCC roots/)
  })

  it('refuses a diagonal rather than comparing three of four legs', () => {
    const diagonal = trade({
      events: [
        ...openEvents([720, 740, 765, 785], '2026-08-28'),
        ev('roll_close', 'short_put', 740, '2026-08-28', T1),
        ev('roll_open', 'short_put', 745, '2026-09-18', T1),
      ],
    })
    const [f] = reconcileJournal([diagonal], [condorPosition([720, 745, 765, 785])], NOW)
    assert.equal(f.status, 'UNCOMPARABLE')
    assert.match(f.detail, /diagonal|multiple expirations/)
  })

  it('refuses when the account side did not reconstruct as a condor', () => {
    const [f] = reconcileJournal(
      [trade({ strikes: [720, 740, 765, 785] })],
      [condorPosition([720, 740, 765, 785], { kind: 'OTHER' })],
      NOW,
    )
    assert.equal(f.status, 'UNCOMPARABLE')
    assert.match(f.detail, /did not reconstruct/)
  })

  it('refuses when two open trades share underlying + expiration', () => {
    // The account groups all 8 legs into one pile and the positions route's
    // Map silently last-wins — neither side can be attributed to one trade.
    const a = trade({ id: 'a', strikes: [720, 740, 765, 785] })
    const b = trade({ id: 'b', strikes: [700, 710, 800, 810] })
    const findings = reconcileJournal([a, b], [condorPosition([720, 740, 765, 785])], NOW)
    assert.equal(findings.length, 2)
    assert.ok(findings.every((f) => f.status === 'UNCOMPARABLE'))
    assert.ok(findings.every((f) => /share SPY 2026-08-28/.test(f.detail)))
  })

  it('an unreconstructible journal never reports MATCH even when a position exists', () => {
    // The whole point: "cannot tell" must never be rendered as "healthy".
    const spx = trade({ symbol: 'SPX', strikes: [6400, 6500, 6800, 6900] })
    const findings = reconcileJournal(
      [spx],
      [condorPosition([6400, 6500, 6800, 6900], { underlying: 'SPX' })],
      NOW,
    )
    assert.ok(findings.every((f) => f.status !== 'MATCH'))
  })
})

describe('reconcileJournal — UNIMPORTED', () => {
  it('flags an account condor with no open journal trade', () => {
    const [f] = reconcileJournal([], [condorPosition([720, 740, 765, 785])], NOW)
    assert.equal(f.status, 'UNIMPORTED')
    assert.equal(f.severity, 'info')
    assert.equal(f.tradeId, null)
    assert.match(f.detail, /Import from Schwab/)
  })

  it('does not flag a position that IS matched to a trade', () => {
    const findings = reconcileJournal(
      [trade({ strikes: [720, 740, 765, 785] })],
      [condorPosition([720, 740, 765, 785])],
      NOW,
    )
    assert.equal(findings.filter((f) => f.status === 'UNIMPORTED').length, 0)
  })

  it('ignores verticals and OTHER rows — only condors are import candidates', () => {
    const findings = reconcileJournal(
      [],
      [
        condorPosition([720, 740, 765, 785], { kind: 'VERTICAL_SPREAD' }),
        condorPosition([720, 740, 765, 785], { kind: 'OTHER', expiration: null }),
      ],
      NOW,
    )
    assert.equal(findings.length, 0)
  })
})

describe('reconcileJournal — ordering and summary', () => {
  it('sorts most severe first so the critical rows cannot scroll off', () => {
    const findings = reconcileJournal(
      [
        trade({ id: 'ok', symbol: 'GLD', strikes: [330, 350, 400, 420] }),
        trade({ id: 'drift', symbol: 'SPY', strikes: [720, 740, 765, 785] }),
      ],
      [
        condorPosition([330, 350, 400, 420], { underlying: 'GLD' }),
        condorPosition([745, 765, 765, 785]),
        condorPosition([100, 110, 120, 130], { underlying: 'IWM' }),
      ],
      NOW,
    )
    assert.equal(findings[0].status, 'DRIFT')
    assert.equal(findings[findings.length - 1].status, 'MATCH')
  })

  it('summarizes counts and the actionable total', () => {
    const findings = reconcileJournal(
      [
        trade({ id: 'drift', strikes: [720, 740, 765, 785] }),
        trade({ id: 'gone', symbol: 'QQQ', strikes: [500, 520, 560, 580] }),
      ],
      [condorPosition([745, 765, 765, 785])],
      NOW,
    )
    const s = summarizeReconciliation(findings)
    assert.equal(s.drift, 1)
    assert.equal(s.phantom, 1)
    assert.equal(s.critical, 2)
    assert.equal(s.match, 0)
  })

  it('an empty account and an empty journal produce no findings', () => {
    assert.deepEqual(reconcileJournal([], [], NOW), [])
  })
})

// ============================================================
// v2.12 — the multiset path. Two open trades on ONE underlying|expiration used
// to return UNCOMPARABLE unconditionally: "neither side can be attributed to a
// specific trade." True, and the wrong question — attribution is impossible for
// fungible identical-strike contracts, but the UNION is comparable.
//
// The live case: two GLD 2026-09-18 condors, aggregated by Schwab into one row
// at quantity 2, which reported UNCOMPARABLE ×2 on every run for eleven days.
// ============================================================

/** A leg carrying the putCall + signed quantity the multiset needs. */
function mLeg(putCall: 'PUT' | 'CALL', strike: number, quantity: number, expiration: string) {
  return {
    role: quantity > 0 ? ('LONG' as const) : ('SHORT' as const),
    strike,
    putCall,
    quantity,
    expiration,
  }
}

/** The AGGREGATED GLD position: one row, every leg at magnitude `lots`. */
function aggregated(
  [lp, sp, sc, lc]: [number, number, number, number],
  lots: number,
  expiration = '2026-09-18',
): ReconcilePosition {
  return {
    kind: 'IRON_CONDOR',
    underlying: 'GLD',
    expiration,
    quantity: lots,
    legs: [
      mLeg('PUT', lp, lots, expiration),
      mLeg('PUT', sp, -lots, expiration),
      mLeg('CALL', sc, -lots, expiration),
      mLeg('CALL', lc, lots, expiration),
    ],
  }
}

const gldTrade = (id: string, strikes: [number, number, number, number]) =>
  trade({ id, symbol: 'GLD', currentExpiration: '2026-09-18', strikes })

describe('reconcileJournal — v2.12 aggregate comparison', () => {
  it('THE GLD CASE — two 1-lot trades vs one aggregated 2-lot row is a MATCH', () => {
    const findings = reconcileJournal(
      [gldTrade('A', [375, 395, 400, 420]), gldTrade('B', [375, 395, 400, 420])],
      [aggregated([375, 395, 400, 420], 2)],
      NOW,
    )
    assert.equal(findings.length, 2)
    assert.ok(findings.every((f) => f.status === 'MATCH'), 'was UNCOMPARABLE before v2.12')
    assert.ok(findings.every((f) => f.severity === 'ok'))
    assert.match(findings[0].detail, /AGGREGATE match/)
  })

  it('says explicitly that attribution is unknowable AND unnecessary', () => {
    const [f] = reconcileJournal(
      [gldTrade('A', [375, 395, 400, 420]), gldTrade('B', [375, 395, 400, 420])],
      [aggregated([375, 395, 400, 420], 2)],
      NOW,
    )
    assert.match(f.detail, /unknowable/)
    assert.match(f.detail, /pre-place guard sizes exits from held contracts/)
  })

  it('DRIFTs when the union does not match — one trade rolled, unjournaled', () => {
    // Trade B was rolled 375/395 → 385/405 at Schwab and never journaled.
    const findings = reconcileJournal(
      [gldTrade('A', [375, 395, 400, 420]), gldTrade('B', [375, 395, 400, 420])],
      [
        {
          kind: 'OTHER',
          underlying: 'GLD',
          expiration: '2026-09-18',
          quantity: 2,
          legs: [
            mLeg('PUT', 375, 1, '2026-09-18'),
            mLeg('PUT', 395, -1, '2026-09-18'),
            mLeg('PUT', 385, 1, '2026-09-18'),
            mLeg('PUT', 405, -1, '2026-09-18'),
            mLeg('CALL', 400, -2, '2026-09-18'),
            mLeg('CALL', 420, 2, '2026-09-18'),
          ],
        },
      ],
      NOW,
    )
    assert.ok(findings.every((f) => f.status === 'DRIFT'))
    assert.ok(findings.every((f) => f.severity === 'critical'))
    assert.match(findings[0].detail, /AGGREGATE drift/)
    assert.match(findings[0].detail, /would build legs that are not held/)
  })

  it('compares an OTHER position fine — no partitioning heuristic needed', () => {
    // Two DIFFERENT-strike condors: eight legs that reconstructPositions gives
    // up on. Splitting them into two condors is genuinely ambiguous; the union
    // is not.
    const findings = reconcileJournal(
      [gldTrade('A', [330, 350, 400, 420]), gldTrade('B', [375, 395, 430, 450])],
      [
        {
          kind: 'OTHER',
          underlying: 'GLD',
          expiration: '2026-09-18',
          quantity: 1,
          legs: [
            mLeg('PUT', 330, 1, '2026-09-18'),
            mLeg('PUT', 350, -1, '2026-09-18'),
            mLeg('CALL', 400, -1, '2026-09-18'),
            mLeg('CALL', 420, 1, '2026-09-18'),
            mLeg('PUT', 375, 1, '2026-09-18'),
            mLeg('PUT', 395, -1, '2026-09-18'),
            mLeg('CALL', 430, -1, '2026-09-18'),
            mLeg('CALL', 450, 1, '2026-09-18'),
          ],
        },
      ],
      NOW,
    )
    assert.ok(findings.every((f) => f.status === 'MATCH'), 'kind=OTHER is irrelevant to the union')
  })

  it('distinguishes PUT from CALL at the same strike', () => {
    // An OTHER position carries the generic roles LONG/SHORT, which lose
    // put-vs-call — which is why the multiset keys on putCall, not role.
    const findings = reconcileJournal(
      [gldTrade('A', [375, 395, 400, 420]), gldTrade('B', [375, 395, 400, 420])],
      [
        {
          kind: 'OTHER',
          underlying: 'GLD',
          expiration: '2026-09-18',
          quantity: 2,
          legs: [
            mLeg('PUT', 375, 2, '2026-09-18'),
            mLeg('PUT', 395, -2, '2026-09-18'),
            mLeg('PUT', 400, -2, '2026-09-18'), // a PUT where a CALL is claimed
            mLeg('CALL', 420, 2, '2026-09-18'),
          ],
        },
      ],
      NOW,
    )
    assert.ok(findings.every((f) => f.status === 'DRIFT'))
  })
})

describe('reconcileJournal — v2.12 keeps "cannot tell" available', () => {
  it('UNCOMPARABLE when a peer trade cannot derive a structure', () => {
    // A diagonal on one of the pair makes the union incomplete, and an
    // incomplete union must never render as an aggregate MATCH.
    const diagonal = trade({
      id: 'B',
      symbol: 'GLD',
      currentExpiration: '2026-09-18',
      events: [
        ...openEvents([375, 395, 400, 420], '2026-09-18'),
        ev('roll_close', 'short_put', 395, '2026-09-18', T1),
        ev('roll_open', 'short_put', 400, '2026-10-16', T1), // rolled OUT in time
      ],
    })
    const findings = reconcileJournal(
      [gldTrade('A', [375, 395, 400, 420]), diagonal],
      [aggregated([375, 395, 400, 420], 2)],
      NOW,
    )
    assert.ok(findings.every((f) => f.status === 'UNCOMPARABLE'))
    assert.match(findings[0].detail, /the union is incomplete/)
  })

  it('UNCOMPARABLE when the account legs lack per-leg quantities', () => {
    // A caller predating v2.12 supplies role+strike only. "Cannot compare" must
    // never silently become "compares equal".
    const findings = reconcileJournal(
      [gldTrade('A', [375, 395, 400, 420]), gldTrade('B', [375, 395, 400, 420])],
      [
        {
          kind: 'IRON_CONDOR',
          underlying: 'GLD',
          expiration: '2026-09-18',
          quantity: 2,
          legs: [
            { role: 'LONG_PUT', strike: 375 },
            { role: 'SHORT_PUT', strike: 395 },
            { role: 'SHORT_CALL', strike: 400 },
            { role: 'LONG_CALL', strike: 420 },
          ],
        },
      ],
      NOW,
    )
    assert.ok(findings.every((f) => f.status === 'UNCOMPARABLE'))
    assert.match(findings[0].detail, /per-leg quantities/)
  })

  it('UNCOMPARABLE when the account holds no such position', () => {
    const findings = reconcileJournal(
      [gldTrade('A', [375, 395, 400, 420]), gldTrade('B', [375, 395, 400, 420])],
      [],
      NOW,
    )
    assert.ok(findings.every((f) => f.status === 'UNCOMPARABLE'))
    assert.match(findings[0].detail, /holds no such position/)
  })

  it('a SINGLE trade on a key still uses the per-trade path and its messages', () => {
    // v2.8's contracts-vs-strikes distinction is tested elsewhere and must not
    // be swallowed by the aggregate path.
    const [f] = reconcileJournal(
      [trade({ strikes: [720, 740, 765, 785] })],
      [condorPosition([745, 765, 765, 785])],
      NOW,
    )
    assert.equal(f.status, 'DRIFT')
    assert.equal(formatStrikes(f.journalStrikes), '720 / 740 / 765 / 785')
  })
})
