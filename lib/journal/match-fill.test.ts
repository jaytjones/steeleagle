import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { classifyFill } from './classify-fill'
import { GOLDEN_FILLS } from './golden-fills.fixture'
import {
  ACTIONABLE_WINDOW_DAYS,
  matchFill,
  matchFills,
  summarizeMatches,
  type MatchTrade,
} from './match-fill'

const {
  GLD_ENTRY,
  SPY_BUTTERFLY_CLOSE,
  SPY_ROLL_CUSTOM,
  SPY_SPLIT_CLOSE,
  SPY_SPLIT_OPEN,
} = GOLDEN_FILLS

// Positioned so every golden fixture (Aug 4–14) is inside ACTIONABLE_WINDOW_DAYS
// and none has expired — the recency bound is exercised deliberately below.
const NOW = new Date('2026-08-10T22:00:00Z')

type Ev = MatchTrade['events'][number]
const ev = (eventType: Ev['eventType'], leg: Ev['leg'], strike: number, expiration: string): Ev => ({
  eventType,
  leg,
  strike,
  expiration,
})

function trade(over: Partial<MatchTrade> = {}): MatchTrade {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    symbol: 'SPY',
    status: 'open',
    currentExpiration: '2026-09-11',
    contracts: 1,
    events: [],
    ...over,
  }
}

const E = '2026-09-11'

/** The SPY 09-11 condor as it stood BEFORE the Aug 5 roll: 725/740/775/790. */
const preRoll = trade({
  events: [
    ev('open', 'long_put', 725, E),
    ev('open', 'short_put', 740, E),
    ev('open', 'short_call', 775, E),
    ev('open', 'long_call', 790, E),
  ],
})

/** The same trade with the Aug 5 roll recorded: 735/750/775/790. */
const rollJournaled = trade({
  events: [
    ...preRoll.events,
    ev('roll_close', 'short_put', 740, E),
    ev('roll_close', 'long_put', 725, E),
    ev('roll_open', 'short_put', 750, E),
    ev('roll_open', 'long_put', 735, E),
  ],
})

describe('matchFill — ALREADY_JOURNALED is structural, not by order id', () => {
  it('recognises a roll recorded BY HAND, with no schwab_order_id anywhere', () => {
    // This is the case that matters: most of April's events are hand-typed and
    // carry a null order id. Matching on the id would call her whole history
    // unjournaled — the bug that produced "122 fills awaiting your judgement".
    const m = matchFill(classifyFill(SPY_ROLL_CUSTOM), [rollJournaled], NOW)
    assert.equal(m.verdict, 'ALREADY_JOURNALED')
    assert.equal(m.tradeId, rollJournaled.id)
    assert.equal(m.actionable, false)
  })

  it('does NOT match when the trade only holds the pre-roll legs', () => {
    const m = matchFill(classifyFill(SPY_ROLL_CUSTOM), [preRoll], NOW)
    assert.equal(m.verdict, 'UNJOURNALED_ROLL')
    assert.equal(m.tradeId, preRoll.id, 'the owning trade is still identified')
    assert.equal(m.actionable, true)
    assert.match(m.detail, /prices GTC closes from the JOURNAL/)
  })

  it('requires EVERY leg — a partially-recorded roll is not journaled', () => {
    const halfRecorded = trade({
      events: [
        ...preRoll.events,
        ev('roll_close', 'short_put', 740, E),
        ev('roll_open', 'short_put', 750, E),
        // the long-put side was never entered
      ],
    })
    assert.equal(matchFill(classifyFill(SPY_ROLL_CUSTOM), [halfRecorded], NOW).verdict, 'UNJOURNALED_ROLL')
  })

  it('ignores trades on a different underlying', () => {
    const gld = trade({ symbol: 'GLD', events: rollJournaled.events })
    assert.equal(matchFill(classifyFill(SPY_ROLL_CUSTOM), [gld], NOW).verdict, 'UNJOURNALED_ROLL')
  })
})

describe('matchFill — the SPLIT roll, both halves', () => {
  // The Aug 14 split roll journaled as ONE Roll form entry: 735/750 → 750/765.
  const splitJournaled = trade({
    events: [
      ev('open', 'long_put', 735, E),
      ev('open', 'short_put', 750, E),
      ev('roll_close', 'short_put', 750, E),
      ev('roll_close', 'long_put', 735, E),
      ev('roll_open', 'short_put', 765, E),
      ev('roll_open', 'long_put', 750, E),
    ],
  })

  it('a single journaled roll matches BOTH tickets', () => {
    // The halves land on the same event types a single-ticket roll produces, so
    // this falls out of the correspondence — no pairing step is needed.
    assert.equal(matchFill(classifyFill(SPY_SPLIT_CLOSE), [splitJournaled], NOW).verdict, 'ALREADY_JOURNALED')
    assert.equal(matchFill(classifyFill(SPY_SPLIT_OPEN), [splitJournaled], NOW).verdict, 'ALREADY_JOURNALED')
  })

  it('an unjournaled half says explicitly that its partner is a separate order', () => {
    const m = matchFill(classifyFill(SPY_SPLIT_CLOSE), [preRoll], NOW)
    assert.equal(m.verdict, 'UNJOURNALED_ROLL')
    assert.match(m.detail, /SPLIT roll/)
    assert.match(m.detail, /journal them together as one roll/)
  })
})

describe('matchFill — closes', () => {
  const butterfly = trade({
    symbol: 'SPY',
    currentExpiration: '2026-08-28',
    events: [
      ev('open', 'long_put', 745, '2026-08-28'),
      ev('open', 'short_put', 765, '2026-08-28'),
      ev('open', 'short_call', 765, '2026-08-28'),
      ev('open', 'long_call', 785, '2026-08-28'),
    ],
  })

  it('an unjournaled close identifies the trade still listed as open', () => {
    const m = matchFill(classifyFill(SPY_BUTTERFLY_CLOSE), [butterfly], NOW)
    assert.equal(m.verdict, 'UNJOURNALED_CLOSE')
    assert.equal(m.tradeId, butterfly.id)
    assert.equal(m.actionable, true)
  })

  it('a journaled close matches even on a CLOSED trade', () => {
    // Closed trades must be searched, or every historical fill reads as
    // unjournaled the moment its trade is closed.
    const closed = trade({
      ...butterfly,
      status: 'closed',
      events: [
        ...butterfly.events,
        ev('close', 'short_call', 765, '2026-08-28'),
        ev('close', 'long_call', 785, '2026-08-28'),
        ev('close', 'short_put', 765, '2026-08-28'),
        ev('close', 'long_put', 745, '2026-08-28'),
      ],
    })
    assert.equal(matchFill(classifyFill(SPY_BUTTERFLY_CLOSE), [closed], NOW).verdict, 'ALREADY_JOURNALED')
  })

  it('a close with no matching trade says so rather than guessing an owner', () => {
    const m = matchFill(classifyFill(SPY_BUTTERFLY_CLOSE), [], NOW)
    assert.equal(m.verdict, 'UNJOURNALED_CLOSE')
    assert.equal(m.tradeId, null)
  })
})

describe('matchFill — rejections are a DRIFT signal, not a journaling task', () => {
  const rejected = (occurredAt: string) => ({
    ...classifyFill(SPY_BUTTERFLY_CLOSE),
    status: 'REJECTED',
    filled: false,
    occurredAt,
  })

  it('a RECENT rejection is actionable and names the likely cause', () => {
    const m = matchFill(rejected('2026-08-09T22:12:00.000Z'), [], NOW)
    assert.equal(m.verdict, 'REJECTED_PLACEMENT')
    assert.equal(m.actionable, true)
    assert.match(m.detail, /strongest available signal/)
    assert.match(m.detail, /unjournaled roll/)
  })

  it('an OLD rejection is kept but NOT actionable', () => {
    // The GLD streak was nine rejections over eleven days. Surfacing all of
    // them forever would bury whichever one is current.
    const m = matchFill(rejected('2026-07-20T22:12:00.000Z'), [], NOW)
    assert.equal(m.verdict, 'REJECTED_PLACEMENT')
    assert.equal(m.actionable, false)
    assert.match(m.detail, /superseded by any later attempt/)
  })

  it('a rejection outranks the shape — it is never read as an unjournaled close', () => {
    assert.equal(matchFill(rejected('2026-08-10T00:00:00.000Z'), [], NOW).verdict, 'REJECTED_PLACEMENT')
  })
})

describe('matchFill — nothing executed', () => {
  it('a WORKING order is NOT_ACTIONABLE', () => {
    const working = { ...classifyFill(SPY_BUTTERFLY_CLOSE), status: 'WORKING', filled: false }
    const m = matchFill(working, [], NOW)
    assert.equal(m.verdict, 'NOT_ACTIONABLE')
    assert.equal(m.actionable, false)
  })

  it('a CANCELED order with no fills is NOT_ACTIONABLE', () => {
    const canceled = { ...classifyFill(SPY_BUTTERFLY_CLOSE), status: 'CANCELED', filled: false }
    assert.equal(matchFill(canceled, [], NOW).actionable, false)
  })
})

describe('matchFill — entries, bounded by relevance', () => {
  it('an entry with no trade but a LIVE expiration is actionable', () => {
    const m = matchFill(classifyFill(GLD_ENTRY), [], NOW) // GLD 2026-09-18
    assert.equal(m.verdict, 'UNJOURNALED_OPEN')
    assert.equal(m.actionable, true)
    assert.match(m.detail, /no standing exit and no 21-DTE alert/)
  })

  it('an entry whose expiration has PASSED is not work', () => {
    const later = new Date('2026-10-01T00:00:00Z')
    const m = matchFill(classifyFill(GLD_ENTRY), [], later)
    assert.equal(m.verdict, 'UNJOURNALED_OPEN', 'the verdict is unchanged')
    assert.equal(m.actionable, false)
  })

  it('an entry recorded on a closed trade is ALREADY_JOURNALED', () => {
    const gld = trade({
      symbol: 'GLD',
      status: 'closed',
      events: [
        ev('open', 'short_call', 400, '2026-09-18'),
        ev('open', 'long_call', 420, '2026-09-18'),
        ev('open', 'short_put', 350, '2026-09-18'),
        ev('open', 'long_put', 330, '2026-09-18'),
      ],
    })
    assert.equal(matchFill(classifyFill(GLD_ENTRY), [gld], NOW).verdict, 'ALREADY_JOURNALED')
  })
})

describe('summarizeMatches', () => {
  it('actionable is the HONEST inbox depth, not the row count', () => {
    const matches = matchFills(
      [
        classifyFill(SPY_ROLL_CUSTOM), // unjournaled → actionable
        classifyFill(SPY_BUTTERFLY_CLOSE), // no trade → actionable
        { ...classifyFill(GLD_ENTRY), status: 'WORKING', filled: false }, // not actionable
      ],
      [preRoll],
      NOW,
    )
    const s = summarizeMatches(matches)
    assert.equal(s.actionable, 2)
    assert.equal(s.byVerdict.NOT_ACTIONABLE, 1)
  })

  it('counts every verdict, including zeros, so a key is never missing', () => {
    const s = summarizeMatches([])
    assert.equal(s.actionable, 0)
    assert.equal(Object.keys(s.byVerdict).length, 7)
    assert.equal(s.byVerdict.ALREADY_JOURNALED, 0)
  })
})

describe('matchFill — the expiry bound', () => {
  // Recency and expiry are BOTH required. This block covers expiry: a fill can
  // be days old and still be nothing to do, because the contract is gone.
  const AFTER_EXPIRY = new Date('2026-08-30T00:00:00Z') // SPY 08-28 has expired

  it('a RECENT close on an already-expired contract is not work', () => {
    const m = matchFill(classifyFill(SPY_BUTTERFLY_CLOSE), [], AFTER_EXPIRY)
    assert.equal(m.verdict, 'UNJOURNALED_CLOSE')
    assert.equal(m.actionable, false)
  })

  it('an OPEN journal trade does NOT rescue an expired contract', () => {
    // Deliberately changed from an earlier draft where an owning open trade
    // outranked expiry. reconcile.ts reports a journal that is stale about a
    // live trade as PHANTOM, precisely and every run; the inbox must not be a
    // second voice for the same finding.
    const stale = trade({
      symbol: 'SPY',
      status: 'open',
      currentExpiration: '2026-08-28',
      events: [
        ev('open', 'long_put', 745, '2026-08-28'),
        ev('open', 'short_put', 765, '2026-08-28'),
        ev('open', 'short_call', 765, '2026-08-28'),
        ev('open', 'long_call', 785, '2026-08-28'),
      ],
    })
    const m = matchFill(classifyFill(SPY_BUTTERFLY_CLOSE), [stale], AFTER_EXPIRY)
    assert.equal(m.tradeId, stale.id, 'the owner is still identified')
    assert.equal(m.actionable, false, 'but reconciliation owns this finding')
  })

  it('an entry whose expiration has passed is not work', () => {
    const afterGld = new Date('2026-09-20T00:00:00Z') // GLD 09-18 expired
    assert.equal(matchFill(classifyFill(GLD_ENTRY), [], afterGld).actionable, false)
  })

  it('a null expiration (diagonal) cannot be proven historic, so it stays work', () => {
    const diagonal = { ...classifyFill(SPY_ROLL_CUSTOM), expiration: null }
    assert.equal(matchFill(diagonal, [], NOW).actionable, true)
  })
})

describe('matchFill — the recency bound (live defect, 2026-08-14)', () => {
  // Successive live runs reported 20, then 13, then 10 actionable fills, and
  // every survivor was a July artifact whose position no longer exists. The
  // ledger holds 180 days; the inbox is for THIS WEEK'S work. Older fills stay
  // queryable as forensics — they are simply not presented as tasks.
  const MUCH_LATER = new Date('2026-09-01T00:00:00Z')

  it('an unjournaled roll older than the window is forensics, not work', () => {
    const m = matchFill(classifyFill(SPY_ROLL_CUSTOM), [preRoll], MUCH_LATER)
    assert.equal(m.verdict, 'UNJOURNALED_ROLL', 'the verdict is unchanged')
    assert.equal(m.actionable, false, 'but it is no longer presented as work')
    assert.match(m.detail, /kept for forensics/)
    assert.match(m.detail, /reported by reconciliation, not here/)
  })

  it('an old unjournaled close is forensics even with an OPEN owning trade', () => {
    // reconcile.ts reports live journal staleness as DRIFT/PHANTOM every run.
    // A second voice for the same finding is how a banner becomes wallpaper.
    const stale = trade({
      symbol: 'SPY',
      status: 'open',
      currentExpiration: '2026-09-11',
      events: preRoll.events,
    })
    assert.equal(matchFill(classifyFill(SPY_BUTTERFLY_CLOSE), [stale], MUCH_LATER).actionable, false)
  })

  it('an old entry is forensics', () => {
    const m = matchFill(classifyFill(GLD_ENTRY), [], MUCH_LATER)
    assert.equal(m.actionable, false)
    assert.match(m.detail, /kept for forensics/)
  })

  it('inside the window, the same fills ARE work', () => {
    assert.equal(matchFill(classifyFill(SPY_ROLL_CUSTOM), [preRoll], NOW).actionable, true)
    assert.equal(matchFill(classifyFill(GLD_ENTRY), [], NOW).actionable, true)
  })

  it('an unreadable timestamp SURFACES rather than hides', () => {
    const broken = { ...classifyFill(SPY_ROLL_CUSTOM), occurredAt: 'not-a-date' }
    assert.equal(matchFill(broken, [preRoll], MUCH_LATER).actionable, true)
  })

  it('the window is a named constant, not a magic number', () => {
    assert.equal(ACTIONABLE_WINDOW_DAYS, 7)
  })
})
