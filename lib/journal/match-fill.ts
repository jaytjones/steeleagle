// ============================================================
// SteelEagle — v2.11 fill ⇄ journal matching (pure — no I/O)
//
// Answers ONE question per ledgered fill: does the journal already contain the
// events this fill would have produced?
//
// ── Why the match is STRUCTURAL, not by order id ──
//
// `trade_events.schwab_order_id` exists, but it is only populated by the
// importer and the sweep. Every event April types by hand — which is most of
// them, because the strategy requires placing trades outside the tool — has it
// null. Matching on the id would report her entire hand-journaled history as
// unjournaled, which is the failure mode that made the first live run report
// "122 fills awaiting your judgement" when nearly all were journaled months ago.
//
// So the match asks a question the journal can actually answer: for each leg
// this fill touched, does a trade hold an event of the corresponding TYPE at
// the same role, strike and expiration? A trade whose event set is a SUPERSET
// of the fill's requirement has already recorded it, whoever typed it.
//
// ── The instruction → event-type correspondence ──
//
//   CONDOR_OPEN    every leg  → `open`
//   CONDOR_CLOSE   every leg  → `close`
//   ROLL           close legs → `roll_close`,  open legs → `roll_open`
//   PARTIAL_CLOSE  every leg  → `roll_close`   (one half of a split roll)
//   PARTIAL_OPEN   every leg  → `roll_open`
//
// The split-roll halves land on the same pair of event types a SINGLE-ticket
// roll produces, so a split roll journaled as one Roll form entry matches BOTH
// halves. That falls out of the correspondence rather than needing the two
// tickets to be paired first — which is why pairing is not attempted here at
// all (see NOT_MATCHED below).
//
// ── Bounding what counts as ACTIONABLE ──
//
// A verdict is not the same as a task. A CONDOR_OPEN from June that matches no
// trade is almost certainly a closed trade whose events were journaled and then
// the trade closed — not work. Only fills that can still be acted on are marked
// actionable, and the bound is deliberately conservative in the direction of
// silence, because an inbox that is always full is the wallpaper hazard again.
// ============================================================

import type { FillClassification, ClassifiedLeg } from './classify-fill'
import type { EventType, Leg, TradeEvent } from './types'

/** The journal side, structurally — so `Trade` satisfies it without importing it. */
export interface MatchTrade {
  id: string
  symbol: string
  status: 'open' | 'closed'
  currentExpiration: string
  contracts: number
  events: Pick<TradeEvent, 'eventType' | 'leg' | 'strike' | 'expiration'>[]
}

export type MatchVerdict =
  /** The journal already holds the events this fill would produce. */
  | 'ALREADY_JOURNALED'
  /** A roll (single ticket or one half of a split) with no journal record. */
  | 'UNJOURNALED_ROLL'
  /** A four-leg close with no journal record. */
  | 'UNJOURNALED_CLOSE'
  /** A four-leg entry with no journal record. */
  | 'UNJOURNALED_OPEN'
  /** Schwab refused the order. Not a journaling task — a DRIFT signal. */
  | 'REJECTED_PLACEMENT'
  /** Nothing executed and nothing was refused: a working or cancelled order. */
  | 'NOT_ACTIONABLE'
  /** Executed, but the shape cannot be turned into a journal proposal. */
  | 'NEEDS_REVIEW'

export interface FillMatch {
  orderId: string
  verdict: MatchVerdict
  /** The trade this fill belongs to, when one could be identified. */
  tradeId: string | null
  /** True when the operator has something to do about it. */
  actionable: boolean
  detail: string
}

/**
 * How recent a fill must be to be presented as WORK.
 *
 * THE SCOPE BOUND, and it is deliberate. The ledger holds 180 days, and most of
 * that predates v2.11 — trades opened, rolled and closed under whatever
 * journaling practice was current at the time. The first live run reported 20
 * actionable fills, then 13, then 10, and every survivor was a July artifact
 * whose position no longer exists. An inbox listing resolved history is the
 * wallpaper hazard, and it buries whatever is genuinely current.
 *
 * A HISTORICAL BACKFILL IS A DIFFERENT EXERCISE from steady-state detection.
 * Older fills stay in the ledger — queryable, and the forensic record v2.11
 * exists to create — they are simply not presented as tasks.
 *
 * Why this does not lose the case v2.11 was built for: `reconcile.ts` is the
 * authority on a journal that is stale about a LIVE trade, and it says so
 * directly as DRIFT or PHANTOM every single run. The inbox is the complementary
 * half — recent activity that needs recording — not a second voice for the same
 * finding. Two reds for one event trains the operator to ignore both.
 *
 * Seven days also covers the sweep's own cadence: it re-places every weeknight,
 * so a rejection older than this was superseded by a later attempt or its cause
 * was fixed. The GLD streak produced NINE rejections over eleven days.
 */
export const ACTIONABLE_WINDOW_DAYS = 7

/** @deprecated Kept as the old name; both bounds are now the same window. */
export const REJECTION_ACTIONABLE_DAYS = ACTIONABLE_WINDOW_DAYS

const MS_PER_DAY = 86_400_000

/** Did this fill occur recently enough to be presented as work? */
function withinWindow(occurredAt: string, now: Date): boolean {
  const at = Date.parse(occurredAt)
  if (Number.isNaN(at)) return true // unreadable timestamp: surface, never hide
  return (now.getTime() - at) / MS_PER_DAY <= ACTIONABLE_WINDOW_DAYS
}

/** `${eventType}|${leg}|${strike}|${expiration}` — the correspondence key. */
function eventKey(eventType: EventType, leg: Leg, strike: number, expiration: string): string {
  return `${eventType}|${leg}|${strike}|${expiration}`
}

/** The event types a classified leg would produce, given the fill's shape. */
function eventTypeFor(shape: FillClassification['shape'], leg: ClassifiedLeg): EventType | null {
  switch (shape) {
    case 'CONDOR_OPEN':
      return 'open'
    case 'CONDOR_CLOSE':
      return 'close'
    case 'ROLL':
    case 'PARTIAL_OPEN':
    case 'PARTIAL_CLOSE':
      return leg.action === 'open' ? 'roll_open' : 'roll_close'
    default:
      return null
  }
}

/** Every (eventType, leg, strike, expiration) this fill would have written. */
export function requiredEventKeys(fill: FillClassification): string[] {
  const keys: string[] = []
  for (const leg of fill.legs) {
    const eventType = eventTypeFor(fill.shape, leg)
    if (eventType === null) return []
    keys.push(eventKey(eventType, leg.role, leg.strike, leg.expiration))
  }
  return keys
}

function tradeEventKeys(trade: MatchTrade): Set<string> {
  return new Set(
    trade.events.map((e) => eventKey(e.eventType, e.leg, e.strike, e.expiration)),
  )
}

/**
 * Match one ledgered fill against the whole journal.
 *
 * @param trades ALL trades, open and closed. Closed ones matter enormously:
 *               a six-week-old entry belongs to a trade that has since closed,
 *               and omitting closed trades would report every historical fill
 *               as unjournaled.
 */
export function matchFill(
  fill: FillClassification,
  trades: readonly MatchTrade[],
  now: Date = new Date(),
): FillMatch {
  const base = { orderId: fill.orderId }

  // ---- Rejections: a drift signal, never a journaling task ----
  if (fill.status === 'REJECTED') {
    const fresh = withinWindow(fill.occurredAt, now)
    return {
      ...base,
      verdict: 'REJECTED_PLACEMENT',
      tradeId: null,
      actionable: fresh,
      detail: fresh
        ? `Schwab REJECTED this ${fill.underlying ?? 'order'} ${fill.shape === 'CONDOR_CLOSE' ? 'close' : 'order'}. ` +
          `A close that Schwab refuses is the strongest available signal that the journal no ` +
          `longer matches the account — most often an unjournaled roll. Compare the strikes.`
        : `Schwab REJECTED this order more than ${ACTIONABLE_WINDOW_DAYS} days ago; ` +
          `kept for forensics, superseded by any later attempt.`,
    }
  }

  // ---- Nothing executed: a working or cancelled order changed nothing ----
  if (!fill.filled) {
    return {
      ...base,
      verdict: 'NOT_ACTIONABLE',
      tradeId: null,
      actionable: false,
      detail: `${fill.status} with no executions — nothing to journal.`,
    }
  }

  const required = requiredEventKeys(fill)
  if (required.length === 0) {
    return {
      ...base,
      verdict: 'NEEDS_REVIEW',
      tradeId: null,
      actionable: true,
      detail:
        `Filled, but shape ${fill.shape} does not map to journal events. ` +
        `${fill.refusals[0] ?? 'Compare in thinkorswim.'}`,
    }
  }

  // ---- Already journaled? A trade whose events SUPERSET the requirement ----
  const candidates = trades.filter((t) => t.symbol === fill.underlying)
  for (const trade of candidates) {
    const held = tradeEventKeys(trade)
    if (required.every((k) => held.has(k))) {
      return {
        ...base,
        verdict: 'ALREADY_JOURNALED',
        tradeId: trade.id,
        actionable: false,
        detail: `The journal already records these legs on trade ${trade.id.slice(0, 8)}.`,
      }
    }
  }

  // ---- Not journaled. Which trade does it belong to, if any? ----
  //
  // For a roll or a close, the trade is the one currently HOLDING the legs
  // being closed — matched on the entry/roll_open events that put them there,
  // not on the current-structure fold, because the fold refuses ambiguity and
  // an unjournaled roll is exactly the ambiguous case.
  const closingLegs = fill.legs.filter((l) => l.action === 'close')
  const owner =
    closingLegs.length > 0
      ? (trades.find((t) => {
          if (t.symbol !== fill.underlying || t.status !== 'open') return false
          const held = tradeEventKeys(t)
          return closingLegs.every(
            (l) =>
              held.has(eventKey('open', l.role, l.strike, l.expiration)) ||
              held.has(eventKey('roll_open', l.role, l.strike, l.expiration)),
          )
        }) ?? null)
      : null

  // ---- The actionability bound ----
  //
  // An unmatched fill on a contract that has already expired is HISTORY, not
  // work: the position is gone and no journal entry can change anything about
  // it. The first live run proved how badly this matters — without the bound,
  // 20 fills were reported actionable, most of them June and July closes of
  // trades that expired weeks ago. An inbox that lists resolved history is the
  // wallpaper hazard, and it buries the two entries that are genuinely live.
  //
  // The ONE exception outranks expiry: if an OPEN journal trade still holds
  // these legs, the journal is stale about a live trade, and that is actionable
  // no matter how old the fill is. A null expiration (a diagonal) counts as
  // relevant — we cannot prove it is history, so we do not assume it.
  const expired =
    fill.expiration !== null &&
    Date.parse(`${fill.expiration}T00:00:00Z`) <
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const recent = withinWindow(fill.occurredAt, now)
  // BOTH must hold: recent enough to be this week's work, AND on a contract
  // that still exists. Neither alone is sufficient — a fresh fill on an expired
  // contract is nothing to do, and an old fill on a live contract is what
  // reconcile.ts reports far more precisely.
  const live = recent && !expired

  if (fill.shape === 'CONDOR_CLOSE') {
    return {
      ...base,
      verdict: 'UNJOURNALED_CLOSE',
      tradeId: owner?.id ?? null,
      actionable: live,
      detail: owner && live
        ? `Closed at Schwab but the journal still lists this trade as OPEN. Record the close.`
        : !recent
          ? `A four-leg close from more than ${ACTIONABLE_WINDOW_DAYS} days ago — kept for ` +
            `forensics. Live journal drift is reported by reconciliation, not here.`
          : expired
          ? `A four-leg close on a contract that expired ${fill.expiration} with no open journal ` +
            `trade — history, not work.`
          : `A four-leg close with no matching open journal trade — it may already be closed ` +
            `under different strikes, or was never imported.`,
    }
  }

  if (fill.shape === 'ROLL' || fill.shape === 'PARTIAL_CLOSE' || fill.shape === 'PARTIAL_OPEN') {
    const split = fill.shape !== 'ROLL'
    return {
      ...base,
      verdict: 'UNJOURNALED_ROLL',
      tradeId: owner?.id ?? null,
      actionable: live,
      detail: !live
        ? !recent
          ? `A roll from more than ${ACTIONABLE_WINDOW_DAYS} days ago — kept for forensics. ` +
            `Live journal drift is reported by reconciliation, not here.`
          : `A roll on a contract that expired ${fill.expiration} — history, not work.`
        : split
          ? `One half of a SPLIT roll (${fill.shape}) with no journal record. Its partner ` +
            `ticket is a separate order — journal them together as one roll.`
          : `A roll with no journal record. The sweep prices GTC closes from the JOURNAL, so ` +
            `until this is recorded it would build legs the account does not hold.`,
    }
  }

  // CONDOR_OPEN with no matching trade. There is no owner concept for an entry
  // — nothing holds its legs yet — so expiry alone decides.
  return {
    ...base,
    verdict: 'UNJOURNALED_OPEN',
    tradeId: null,
    actionable: recent && !expired,
    detail: recent && !expired
      ? `An entry with no journal trade, expiring ${fill.expiration}. Import it, or it will ` +
        `have no standing exit and no 21-DTE alert.`
      : !recent
        ? `An entry from more than ${ACTIONABLE_WINDOW_DAYS} days ago with no journal trade — ` +
          `kept for forensics, not presented as work.`
        : `An entry with no journal trade, but it expired on ${fill.expiration} — history.`,
  }
}

export interface MatchSummary {
  /** Fills the operator needs to act on. The honest inbox depth. */
  actionable: number
  alreadyJournaled: number
  byVerdict: Record<MatchVerdict, number>
}

export function matchFills(
  fills: readonly FillClassification[],
  trades: readonly MatchTrade[],
  now: Date = new Date(),
): FillMatch[] {
  return fills.map((f) => matchFill(f, trades, now))
}

export function summarizeMatches(matches: readonly FillMatch[]): MatchSummary {
  const byVerdict = {
    ALREADY_JOURNALED: 0,
    UNJOURNALED_ROLL: 0,
    UNJOURNALED_CLOSE: 0,
    UNJOURNALED_OPEN: 0,
    REJECTED_PLACEMENT: 0,
    NOT_ACTIONABLE: 0,
    NEEDS_REVIEW: 0,
  } as Record<MatchVerdict, number>

  for (const m of matches) byVerdict[m.verdict] += 1

  return {
    actionable: matches.filter((m) => m.actionable).length,
    alreadyJournaled: byVerdict.ALREADY_JOURNALED,
    byVerdict,
  }
}
