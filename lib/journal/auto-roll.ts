// ============================================================
// SteelEagle — v2.15 gated auto-journal, ROLLS (pure — no I/O)
//
// Discharges the "rolls to be revisited" half of v2.14's scope decision.
// Decides WHICH filled single-ticket rolls the cron may journal without JJ.
// Writes nothing itself; the route does the I/O, per the build pattern.
// Spec: docs/steeleagle-v2-15-auto-roll-spec.md.
//
// ── The hazard this module answers ──
//
// A zero residual proves COMPLETENESS, not CORRECTNESS. A misread CLOSE
// announces itself next sweep as a DRIFT; a misread ROLL does not — the
// structure matches the account, reconciliation reads MATCH, and the only thing
// wrong is the running credit, which is exactly what the next 50% GTC is priced
// from. Schwab accepts that order (the legs are held) and it can fill.
//
// So two things, both required:
//   1. Narrow the interpretation surface until a misread is implausible (the
//      conditions below).
//   2. HOLD the one live-money consequence behind JJ's eyes (decision 3): every
//      write here sets `trades.exit_hold_order_id` in the same transaction, and
//      the planner withholds the GTC until she confirms.
//
// ── Decisions (JJ, 2026-10-30 / 2026-10-31) ──
//
//   - One-sided (2+2) rolls are the norm; 4+4 is ADMITTED (§8.2) because the
//     same invariants cover it, never as the target case.
//   - SAME EXPIRATION ONLY. A roll out in time stays an inbox card.
//   - Butterfly results are INTENDED (§8.4). A one-sided roll landing SP == SC
//     passes the `<=` — pinned live by SPY_ROLL_0828_TO_FLY.
//   - Single-ticket only. Split rolls (two VERTICAL tickets) are never paired.
//
// ── Conditions, in order ──
//
// A failure EARLY in the list is a silent skip (not ours); a failure LATER is a
// recorded refusal (the inbox card stays). Refusals are recorded, not flagged —
// the card is already the delivery surface (v2.14).
//
//   G  gate OPEN (shared with auto-close — auto-journal-gate.ts)
//   1  disposition === 'pending'                      skip
//   2  shape ROLL, FILLED, no classifier refusals     skip
//   3  occurredAt inside the interval                 skip
//   A  ALREADY JOURNALED (matchFill)                  skip
//   4  exactly one owning open trade                  0 skip · >1 REFUSE
//   5  fill contracts === trade contracts             REFUSE
//   H  no standing GTC, no unconfirmed hold           REFUSE
//   R  first roll of this trade in the interval       REFUSE
//   6  same expiration as the trade                   REFUSE
//   7  one-sided 2+2 (one putCall) or full 4+4        REFUSE
//   8  every leg has a real price                     REFUSE
//   9a closing legs are what the journal HOLDS NOW    REFUSE
//   9b post-roll structure well-formed (fold-only)    REFUSE
//
// ── Three conditions the spec did not have, and why ──
//
// A — `closeOwners` matches on the `open`/`roll_open` events that EVER put a leg
//   in place, and a rolled trade stays OPEN. So a roll JJ already journaled by
//   hand still has exactly one owner. For closes that never mattered (journaling
//   a close closes the trade, which drops out); for rolls, "0 owners = already
//   journaled" is false, and without A the cron would write her roll twice. A
//   uses `matchFill`'s own verdict — the predicate the inbox already shows her —
//   so the two can never disagree about what is journaled.
//
// 9a — the fold never checks that a `roll_close` strike matches the strike
//   currently held; it only vacates the role. So 9b alone would pass a roll
//   whose closing legs the journal does not hold — i.e. a journal that is
//   already behind the account. That is the GLD-streak shape, and writing on top
//   of it compounds the drift.
//
// H — `rollTrade` nulls `exit_order_id`. Step (a) has already cleared dead
//   orders by the time this runs, so a non-null id here means a GTC on the
//   PRE-ROLL legs is still working at Schwab. The manual Roll form warns "cancel
//   it in TOS"; nobody reads a warning at 4:30 PM. And an existing HOLD means an
//   earlier auto-roll is unconfirmed — writing again would replace the order id
//   the confirm card names.
// ============================================================

import type { FillClassification } from './classify-fill'
import { closeOwners, matchFill, type MatchTrade } from './match-fill'
import { gateDecision, inInterval, type AutoJournalInterval } from './auto-journal-gate'
import { foldStructure, structureOnlyRefusal, type StructureEvent } from './current-structure'
import { rollInputFromFill } from './roll-from-fill'
import type { Leg, RollEventInput } from './types'

/** The ledger row, structurally — `StoredFill` satisfies it. */
export interface AutoRollFill {
  classification: FillClassification
  disposition: string
}

/**
 * The journal side. A superset of `MatchTrade`: the fold needs `occurredAt` /
 * `createdAt` on every event, and condition H needs both exit columns.
 */
export interface AutoRollTrade extends Omit<MatchTrade, 'events'> {
  exitOrderId: string | null
  exitHoldOrderId: string | null
  events: StructureEvent[]
}

export interface AutoRollWrite {
  orderId: string
  tradeId: string
  symbol: string
  expiration: string
  contracts: number
  occurredAt: string
  /**
   * The events, built ONCE. Condition 9b already had to build them to fold
   * them; re-deriving at write time is the two-calls-can-disagree hazard. The
   * route re-classifies the live order and refuses unless it reproduces these.
   */
  events: RollEventInput[]
}

export interface AutoRollRefusal {
  orderId: string
  tradeId: string | null
  reason: string
}

export interface AutoRollPlan {
  gate: 'OPEN' | 'CLOSED'
  gateReason: string
  write: AutoRollWrite[]
  refused: AutoRollRefusal[]
  /** Filled single-ticket rolls inside the interval that were looked at. */
  considered: number
}

const LEG_LABEL: Record<Leg, string> = {
  long_put: 'LP',
  short_put: 'SP',
  short_call: 'SC',
  long_call: 'LC',
}

const LEG_KEY = {
  long_put: 'longPut',
  short_put: 'shortPut',
  short_call: 'shortCall',
  long_call: 'longCall',
} as const

function isFilledRoll(fill: FillClassification): boolean {
  return (
    fill.shape === 'ROLL' &&
    fill.filled &&
    fill.status === 'FILLED' &&
    fill.refusals.length === 0
  )
}

/**
 * Condition 7. null = admissible. The classifier already guarantees every open
 * role is also closed; this adds the converse (no orphan close — that would
 * leave a role vacant) and the one-sided rule.
 */
function shapeRefusal(fill: FillClassification): string | null {
  const closes = fill.legs.filter((l) => l.action === 'close')
  const opens = fill.legs.filter((l) => l.action === 'open')
  const opened = new Set(opens.map((l) => l.role))
  const orphan = closes.find((l) => !opened.has(l.role))
  if (orphan) {
    return (
      `the ticket closes ${LEG_LABEL[orphan.role]} without reopening it — that is a partial ` +
      `unwind, not a roll. Journal it by hand.`
    )
  }
  if (closes.length === 2 && opens.length === 2) {
    const sides = new Set(fill.legs.map((l) => l.putCall))
    if (sides.size !== 1) {
      return (
        `a two-leg roll that mixes puts and calls is not a spread roll — ` +
        `journal it by hand.`
      )
    }
    return null
  }
  // JJ, 2026-10-31 (§8.2): admit. The classifier's per-side role uniqueness
  // makes 4+4 exactly the four roles, closed and reopened.
  if (closes.length === 4 && opens.length === 4) return null
  return (
    `a ${closes.length}+${opens.length} ticket is neither a one-sided (2+2) nor a full ` +
    `(4+4) roll — journal it by hand.`
  )
}

/** Fill to occurredAt, ascending — so the FIRST roll of a trade is the one written. */
function chronological(rows: readonly AutoRollFill[]): AutoRollFill[] {
  return [...rows].sort((a, b) =>
    a.classification.occurredAt.localeCompare(b.classification.occurredAt),
  )
}

/**
 * Which filled rolls may be journaled without the operator.
 *
 * `trades` must be ALL trades, open and closed, read AFTER the exit sweep's
 * reconcile and clear steps — condition H relies on step (a) having already
 * nulled any dead GTC.
 *
 * Never throws. A malformed fill refuses; it cannot take down the batch.
 */
export function planAutoRolls(input: {
  fills: readonly AutoRollFill[]
  trades: readonly AutoRollTrade[]
  interval: AutoJournalInterval | null
  balanceStatus: string | null
}): AutoRollPlan {
  const decision = gateDecision(input.interval, input.balanceStatus)
  if (decision.gate === 'CLOSED') {
    return { write: [], refused: [], considered: 0, ...decision }
  }
  const interval = decision.interval

  const write: AutoRollWrite[] = []
  const refused: AutoRollRefusal[] = []
  const writtenTrades = new Set<string>()
  let considered = 0
  // The journal AS IT WILL BE once this plan's writes land. A trade accepted for
  // a write carries its proposed events from then on, so a second same-side roll
  // later in the interval (whose closing legs only exist after the first) still
  // finds its owner and is REFUSED by R by name — rather than skipping silently
  // as an ownerless fill, which would make "declined" look like "nothing there".
  let trades: readonly AutoRollTrade[] = input.trades

  for (const row of chronological(input.fills)) {
    // 1 — the operator's judgement outranks the gate.
    if (row.disposition !== 'pending') continue

    const fill = row.classification
    // 2, 3
    if (!isFilledRoll(fill)) continue
    if (!inInterval(fill.occurredAt, interval)) continue
    considered++

    const refuse = (tradeId: string | null, reason: string) =>
      refused.push({ orderId: fill.orderId, tradeId, reason })

    try {
      // A — journaled by hand already (or by an earlier run). Not ours.
      if (matchFill(fill, trades, interval.to).verdict === 'ALREADY_JOURNALED') continue

      // 4
      const owners = closeOwners(fill, trades)
      if (owners.length === 0) continue
      if (owners.length > 1) {
        refuse(
          null,
          `${owners.length} open journal trades hold these legs ` +
            `(${owners.map((t) => t.id.slice(0, 8)).join(', ')}) — nothing in the fill says ` +
            `which one rolled. Journal it by hand; auto-journal will not guess between ` +
            `same-strike trades.`,
        )
        continue
      }
      const trade = owners[0]
      const tag = `trade ${trade.id.slice(0, 8)} (${trade.symbol})`

      // 5
      if (fill.contracts !== trade.contracts) {
        refuse(
          trade.id,
          `the fill rolled ${fill.contracts} contract(s) but ${tag} holds ${trade.contracts} — ` +
            `a partial or aggregated roll is never journaled automatically. Use the Roll form.`,
        )
        continue
      }

      // H
      if (trade.exitOrderId !== null) {
        refuse(
          trade.id,
          `${tag} still has standing GTC ${trade.exitOrderId} on record, which targets the ` +
            `PRE-ROLL legs. Cancel it in thinkorswim, then journal the roll with the Roll form.`,
        )
        continue
      }
      if (trade.exitHoldOrderId !== null) {
        refuse(
          trade.id,
          `${tag} is still awaiting your confirmation of the automatic journal entry from order ` +
            `${trade.exitHoldOrderId}. Confirm that one first, then journal this roll by hand.`,
        )
        continue
      }

      // R
      if (writtenTrades.has(trade.id)) {
        refuse(
          trade.id,
          `a second roll of ${tag} in the same interval — only the first is journaled ` +
            `automatically. Journal this one by hand after confirming the first.`,
        )
        continue
      }

      // 6 — decision 2.
      if (fill.expiration === null || fill.expiration !== trade.currentExpiration) {
        refuse(
          trade.id,
          fill.expiration === null
            ? `the ticket spans more than one expiration — a roll out in time is never ` +
                `journaled automatically. Use the Roll form.`
            : `the ticket is on ${fill.expiration} but ${tag} is on ${trade.currentExpiration} — ` +
                `only same-expiration rolls are journaled automatically. Use the Roll form.`,
        )
        continue
      }

      // 7
      const shape = shapeRefusal(fill)
      if (shape !== null) {
        refuse(trade.id, shape)
        continue
      }

      // 8 — stated explicitly for a clean reason; rollInputFromFill refuses too.
      const unpriced = fill.legs.find((l) => l.price === null)
      if (unpriced) {
        refuse(
          trade.id,
          `Schwab returned no execution price for ${unpriced.occSymbol} — a write never ` +
            `fabricates a price. Use the Roll form with the TOS numbers.`,
        )
        continue
      }

      // 9a — the closing legs must be what the journal holds NOW.
      let held
      try {
        held = foldStructure(trade.events)
      } catch (err) {
        refuse(
          trade.id,
          `the journal's current structure for ${tag} cannot be reconstructed ` +
            `(${err instanceof Error ? err.message : String(err)}) — journal the roll by hand.`,
        )
        continue
      }
      const stale = fill.legs.find(
        (l) =>
          l.action === 'close' &&
          (held[LEG_KEY[l.role]].strike !== l.strike || held.expiration !== l.expiration),
      )
      if (stale) {
        refuse(
          trade.id,
          `the ticket closes ${LEG_LABEL[stale.role]} ${stale.strike} but the journal holds ` +
            `${LEG_LABEL[stale.role]} ${held[LEG_KEY[stale.role]].strike} on ${tag} — the journal ` +
            `is already behind the account (an earlier roll unjournaled?). Reconcile by hand.`,
        )
        continue
      }

      // Build the events once — 9b folds them, the route writes them.
      const built = rollInputFromFill(fill)

      // 9b — fold-only: an index roll is as journalable as an ETF roll (§3.1).
      const proposed: StructureEvent[] = built.events.map((e) => ({
        eventType: e.eventType,
        leg: e.leg,
        strike: e.strike,
        expiration: e.expiration,
        occurredAt: built.occurredAt,
        createdAt: built.occurredAt,
      }))
      const after = structureOnlyRefusal([...trade.events, ...proposed])
      if (after !== null) {
        refuse(
          trade.id,
          `the post-roll structure would not be a valid condor or butterfly (${after}) — ` +
            `journal it by hand.`,
        )
        continue
      }

      writtenTrades.add(trade.id)
      trades = trades.map((t) =>
        t.id === trade.id ? { ...t, events: [...t.events, ...proposed] } : t,
      )
      write.push({
        orderId: fill.orderId,
        tradeId: trade.id,
        symbol: trade.symbol,
        expiration: trade.currentExpiration,
        contracts: built.contracts,
        occurredAt: built.occurredAt,
        events: built.events,
      })
    } catch (err) {
      // A malformed fill refuses; it never takes down the batch.
      refuse(null, `could not evaluate: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { gate: 'OPEN', gateReason: decision.gateReason, write, refused, considered }
}

/** One line for the sweep log. Never empty, and never silent about a refusal. */
export function summarizeAutoRoll(plan: AutoRollPlan): string {
  if (plan.gate === 'CLOSED') return `auto-journal (rolls) held: ${plan.gateReason}`
  if (plan.write.length === 0 && plan.refused.length === 0) {
    return `auto-journal (rolls) ran with nothing to do — ${plan.considered} filled roll(s) in the interval`
  }
  const parts = [`${plan.write.length} roll(s) journaled automatically, GTC held`]
  if (plan.refused.length > 0) parts.push(`${plan.refused.length} refused (left in the inbox)`)
  return parts.join(' · ')
}
