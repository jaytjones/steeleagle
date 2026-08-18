// ============================================================
// SteelEagle — journal ⇄ position exit linkage (pure — no I/O)
//
// One Schwab position row can correspond to MORE THAN ONE journal trade.
//
// Schwab AGGREGATES identical-strike positions: two 1-lot condors at the same
// strikes and expiration arrive as one row at quantity 2, indistinguishable
// from a single 2-lot. That is not an accident to be repaired — scaling into
// the same setup when it still reads well is a DELIBERATE, SUPPORTED WORKFLOW
// (JJ, 2026-08-14) — and the two entries stay TWO TRADES, because they were
// opened at different times for different credits and different BPRs, so each
// deserves its own 50% target. Merging them would blend two real entries into
// one fictional average.
//
// The defect this module fixes: `/api/positions` built
// `new Map(openTrades.map(t => [key, t]))`, so the SECOND trade on a key
// silently overwrote the first and one live standing GTC was invisible on the
// Monitor. Both existed at Schwab (GLD 2026-09-18: 1007605997326 @6.82 and
// 1007605997334 @5.11); the Monitor showed one. Silent last-wins is the same
// failure class as v2.6.1's missing roll badge — "healthy" and "not rendered"
// looked identical.
//
// So the value on a key is a LIST, and the caller cannot accidentally read one
// trade where two exist: the type is an array at every call site.
//
// Layering: this is `lib/strategy`, not `lib/journal`, precisely because it
// needs `computeExitDebit` from the Schwab layer — the journal must not depend
// on Schwab (see lib/journal/current-structure.ts).
// ============================================================

import { computeExitDebit } from '../schwab/exit-ticket'
import { isPriceableStructure, type StructureEvent } from '../journal/current-structure'
import type { Trade } from '../journal/types'

/**
 * The trade fields the linkage needs — nothing else.
 *
 * Narrow structural input, as in `MatchTrade` / `ReconcileTrade`: the pure
 * module states exactly what it reads, and a test does not have to invent a
 * plausible-looking full `Trade`.
 */
export type ExitLinkTrade = Pick<
  Trade,
  | 'id'
  | 'symbol'
  | 'status'
  | 'openedAt'
  | 'currentExpiration'
  | 'contracts'
  | 'totalCreditCollected'
  | 'totalDebitPaid'
  | 'exitOrderId'
> & { events: StructureEvent[] }

/** One journal trade's standing-exit facts, as the Monitor renders them. */
export interface JournalExitLink {
  tradeId: string
  /** Standing GTC order id, or null when none is on record. */
  exitOrderId: string | null
  /**
   * True when the sweep will NOT auto-place a GTC because `currentStructure`
   * refuses this event log (diagonal, vacant leg, multi-root index, unpinned
   * fixture). Same predicate the planner gates on, so the chip cannot disagree
   * with what the sweep actually does.
   */
  manualGtc: boolean
  /** Mechanical 50% target debit for THIS trade, or null when unpriceable. */
  targetDebit: string | null
  /** This trade's own lot size — not the aggregated position quantity. */
  contracts: number
  openedAt: string
}

/** `${symbol}|${expiration}` — the same key the guard and reconcile use. */
export function exitLinkKey(symbol: string, expiration: string): string {
  return `${symbol}|${expiration}`
}

/**
 * Every open trade's exit link, grouped by `symbol|currentExpiration`.
 *
 * Order within a key is deterministic — opened-at ascending, id as tiebreak —
 * so the chips do not reorder between refreshes (the same reason v2.10's
 * expiration tiebreak is deterministic: an unstable order reads as a change).
 *
 * Closed trades are dropped defensively: a chip for a closed trade would
 * advertise an exit that is no longer live.
 */
export function buildExitLinks(trades: readonly ExitLinkTrade[]): Map<string, JournalExitLink[]> {
  const byKey = new Map<string, JournalExitLink[]>()

  const open = trades
    .filter((t) => t.status === 'open')
    .slice()
    .sort((a, b) => (a.openedAt === b.openedAt ? cmp(a.id, b.id) : cmp(a.openedAt, b.openedAt)))

  for (const trade of open) {
    const key = exitLinkKey(trade.symbol, trade.currentExpiration)
    const list = byKey.get(key)
    const link = toLink(trade)
    if (list) list.push(link)
    else byKey.set(key, [link])
  }

  return byKey
}

/** Links for one position's key. Empty array = no journal trade matches. */
export function exitLinksFor(
  byKey: Map<string, JournalExitLink[]>,
  symbol: string,
  expiration: string,
): JournalExitLink[] {
  return byKey.get(exitLinkKey(symbol, expiration)) ?? []
}

function toLink(trade: ExitLinkTrade): JournalExitLink {
  let targetDebit: string | null = null
  try {
    targetDebit = computeExitDebit(
      trade.totalCreditCollected,
      trade.totalDebitPaid,
      trade.contracts,
    )
  } catch {
    // Non-positive net credit or bad accounting — the chip renders id-only.
    // The LINK still stands: a trade whose target cannot be priced may still
    // have a live GTC at Schwab, and hiding it is how one went unseen.
  }

  return {
    tradeId: trade.id,
    exitOrderId: trade.exitOrderId,
    manualGtc: !isPriceableStructure(trade.symbol, trade.events),
    targetDebit,
    contracts: trade.contracts,
    openedAt: trade.openedAt,
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
