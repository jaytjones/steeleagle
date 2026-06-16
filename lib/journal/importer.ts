// ============================================================
// SteelEagle — Schwab Position Importer logic (Session 10 — v1.5.1)
//
// Pure functions, no I/O. The pipeline:
//   parsePositionLegs  → flatten Schwab positions to option legs
//   groupIntoCondors   → assemble 4-leg iron-condor candidates
//   enrichWithOrderHistory → recover real fill prices + open date from orders
//   deduplicateCandidates  → drop condors already in the journal
//
// Kept pure (like trade-math.ts) so the real edge-case complexity — split
// orders, partial closes, zero fills, mismatched quantities — is fully
// unit-testable without mocking Schwab or the DB.
// ============================================================

import type { SchwabOrder } from '@/lib/schwab/orders'
import { round2 } from '@/lib/journal/trade-math'
import { parseOccSymbol } from '@/lib/strategy/reconstruct-positions'
import type {
  ImportCandidate,
  ImportLeg,
  IncompletePosition,
  RawPositionLeg,
} from '@/lib/journal/types'

// --------------------------------------------------------
// 1. parsePositionLegs
// --------------------------------------------------------

/** Narrow Schwab position shape — only the fields the parser reads. */
interface RawSchwabPosition {
  instrument?: {
    assetType?: string
    symbol?: string
  }
  longQuantity?: number
  shortQuantity?: number
  averagePrice?: number
}

/** ISO date helper — trims a "YYYY-MM-DDT..." timestamp to "YYYY-MM-DD". */
function toYmd(raw: string): string {
  return raw.slice(0, 10)
}

/**
 * Parse Schwab position data into flat RawPositionLeg objects.
 *
 * Schwab returns a flat array of individual option legs and does NOT reliably
 * include strikePrice / expirationDate / underlyingSymbol on the position's
 * instrument — those are parsed from the 21-char OCC `symbol` (same approach as
 * reconstruct-positions.ts, the authority on this payload). averagePrice is
 * abs()'d because Schwab may sign short premium negative.
 *
 * Filters out non-option positions, unparseable OCC symbols, and 0-quantity legs.
 */
export function parsePositionLegs(schwabPositions: unknown[]): RawPositionLeg[] {
  const legs: RawPositionLeg[] = []

  for (const raw of schwabPositions) {
    const p = raw as RawSchwabPosition
    const ins = p?.instrument
    if (!ins || ins.assetType !== 'OPTION' || !ins.symbol) continue

    const parsed = parseOccSymbol(ins.symbol)
    if (!parsed) continue

    const longQty = p.longQuantity ?? 0
    const shortQty = p.shortQuantity ?? 0
    if (longQty <= 0 && shortQty <= 0) continue // zero net quantity — skip

    legs.push({
      occSymbol: ins.symbol,
      underlying: parsed.underlying,
      putCall: parsed.putCall,
      strike: parsed.strike,
      expiration: parsed.expiration,
      longQty,
      shortQty,
      averagePrice: Math.abs(p.averagePrice ?? 0),
    })
  }

  return legs
}

// --------------------------------------------------------
// 2. groupIntoCondors
// --------------------------------------------------------

/** Net contract count a leg represents (it is either long or short, never both). */
function legQty(leg: RawPositionLeg): number {
  return leg.longQty > 0 ? leg.longQty : leg.shortQty
}

function makeLeg(raw: RawPositionLeg, action: 'BUY' | 'SELL'): ImportLeg {
  return {
    action,
    putCall: raw.putCall,
    strike: raw.strike,
    price: round2(raw.averagePrice),
    occSymbol: raw.occSymbol,
  }
}

/**
 * Group RawPositionLegs into ImportCandidates.
 *
 * Grouping key: underlying + expiration. A valid condor group has exactly 4
 * legs of equal quantity: 1 long put, 1 short put, 1 short call, 1 long call,
 * with strikes ordered LP < SP < SC < LC. Anything else → IncompletePosition.
 *
 * Candidates start at 'marks_only' confidence with averagePrice on each leg;
 * enrichWithOrderHistory upgrades them where a filled order is found.
 */
export function groupIntoCondors(legs: RawPositionLeg[]): {
  candidates: ImportCandidate[]
  incomplete: IncompletePosition[]
} {
  const candidates: ImportCandidate[] = []
  const incomplete: IncompletePosition[] = []

  // Group by underlying + expiration, preserving first-seen order for stable output.
  const groups = new Map<string, RawPositionLeg[]>()
  for (const leg of legs) {
    const key = `${leg.underlying}__${leg.expiration}`
    const list = groups.get(key) ?? []
    list.push(leg)
    groups.set(key, list)
  }

  for (const group of groups.values()) {
    const { underlying, expiration } = group[0]
    const flag = (legsFound: number, reason: string) =>
      incomplete.push({ underlying, expiration, legsFound, reason })

    if (group.length !== 4) {
      flag(
        group.length,
        group.length < 4
          ? `${group.length} of 4 legs found (possible partial close).`
          : `${group.length} legs found — not a clean 4-leg condor (stacked positions?).`,
      )
      continue
    }

    // All four legs must represent the same number of contracts.
    const qty = legQty(group[0])
    if (!group.every((l) => legQty(l) === qty)) {
      flag(4, 'Mismatched quantities — possible partial close.')
      continue
    }

    const puts = group.filter((l) => l.putCall === 'PUT')
    const calls = group.filter((l) => l.putCall === 'CALL')
    if (puts.length !== 2 || calls.length !== 2) {
      flag(4, `Not a balanced condor — found ${puts.length} put(s) and ${calls.length} call(s).`)
      continue
    }

    const shortPut = puts.find((l) => l.shortQty > 0)
    const longPut = puts.find((l) => l.longQty > 0)
    const shortCall = calls.find((l) => l.shortQty > 0)
    const longCall = calls.find((l) => l.longQty > 0)
    if (!shortPut || !longPut || !shortCall || !longCall) {
      flag(4, 'Could not identify one short + one long on each side (not a short condor).')
      continue
    }

    // Wings sit outside the body: LP < SP < SC < LC.
    if (!(longPut.strike < shortPut.strike && shortPut.strike < shortCall.strike && shortCall.strike < longCall.strike)) {
      flag(4, 'Strikes are not ordered as a standard iron condor (LP < SP < SC < LC).')
      continue
    }

    candidates.push({
      candidateId: `${underlying}-${expiration}`,
      underlying,
      expiration,
      contracts: qty,
      longPut: makeLeg(longPut, 'BUY'),
      shortPut: makeLeg(shortPut, 'SELL'),
      shortCall: makeLeg(shortCall, 'SELL'),
      longCall: makeLeg(longCall, 'BUY'),
      confidence: 'marks_only',
      openDate: null,
      schwabOrderId: null,
      splitOrder: false,
      initialBpr: 0,
    })
  }

  return { candidates, incomplete }
}

// --------------------------------------------------------
// 3. enrichWithOrderHistory
// --------------------------------------------------------

const OPENING_INSTRUCTIONS = new Set(['BUY_TO_OPEN', 'SELL_TO_OPEN'])

/** Map each opening order-leg OCC symbol → its actual fill price for one order. */
function fillPricesForOrder(order: SchwabOrder): Map<string, number> {
  const prices = new Map<string, number>()
  const legs = order.orderLegCollection ?? []

  // legId → OCC symbol (only opening legs are relevant to an import).
  const symbolByLegId = new Map<number, string>()
  legs.forEach((leg, idx) => {
    if (!OPENING_INSTRUCTIONS.has(leg.instruction)) return
    const legId = leg.legId ?? idx + 1 // Schwab legIds are 1-based; fall back to position
    symbolByLegId.set(legId, leg.instrument.symbol)
  })

  for (const activity of order.orderActivityCollection ?? []) {
    for (const exec of activity.executionLegs ?? []) {
      const symbol = symbolByLegId.get(exec.legId)
      if (!symbol) continue
      // Later activities (additional partial fills) overwrite — the last fill wins;
      // for the single-activity common case this is just the fill price.
      prices.set(symbol, exec.price)
    }
  }

  return prices
}

/** The four OCC symbols of a candidate, in LP/SP/SC/LC order. */
function candidateSymbols(c: ImportCandidate): string[] {
  return [c.longPut.occSymbol, c.shortPut.occSymbol, c.shortCall.occSymbol, c.longCall.occSymbol]
}

/**
 * Enrich candidates with order-history fill data where a match is found.
 *
 * For each candidate, find the filled orders whose opening legs cover all four
 * of its OCC symbols (one order, or two split spread orders). When fully
 * covered with non-zero fills: confidence → 'matched', prices overridden from
 * the fills, openDate from the earliest contributing order's enteredTime,
 * schwabOrderId from that order, and splitOrder flagged when 2 orders combined.
 *
 * If any required fill is missing or 0, the candidate stays 'marks_only' with
 * its averagePrice prices (spec §7: zero-fill rows fall back to marks).
 * Never throws — a bad order shape just means no match for that candidate.
 */
export function enrichWithOrderHistory(
  candidates: ImportCandidate[],
  filledOrders: SchwabOrder[],
): ImportCandidate[] {
  return candidates.map((c) => {
    const wanted = new Set(candidateSymbols(c))

    // Orders contributing at least one opening fill for this candidate's symbols.
    const contributing: { order: SchwabOrder; prices: Map<string, number> }[] = []
    for (const order of filledOrders) {
      const prices = fillPricesForOrder(order)
      let touches = false
      for (const sym of prices.keys()) {
        if (wanted.has(sym)) {
          touches = true
          break
        }
      }
      if (touches) contributing.push({ order, prices })
    }
    if (contributing.length === 0) return c

    // Resolve a fill price for each of the four legs across the contributing orders.
    const priceBySymbol = new Map<string, number>()
    for (const { prices } of contributing) {
      for (const [sym, price] of prices) {
        if (wanted.has(sym) && !priceBySymbol.has(sym)) priceBySymbol.set(sym, price)
      }
    }

    const allFour = candidateSymbols(c).every((s) => priceBySymbol.has(s))
    if (!allFour) return c // partial coverage — leave as marks_only

    // Zero / missing fill on any leg → fall back to averagePrice (spec §7).
    const anyZeroFill = candidateSymbols(c).some((s) => (priceBySymbol.get(s) ?? 0) <= 0)
    if (anyZeroFill) return c

    // Earliest contributing order supplies the open date + the order id.
    const sorted = [...contributing].sort(
      (a, b) => new Date(a.order.enteredTime).getTime() - new Date(b.order.enteredTime).getTime(),
    )
    const earliest = sorted[0].order

    const withPrice = (leg: ImportLeg): ImportLeg => ({
      ...leg,
      price: round2(priceBySymbol.get(leg.occSymbol) as number),
    })

    return {
      ...c,
      longPut: withPrice(c.longPut),
      shortPut: withPrice(c.shortPut),
      shortCall: withPrice(c.shortCall),
      longCall: withPrice(c.longCall),
      confidence: 'matched',
      openDate: toYmd(earliest.enteredTime),
      schwabOrderId: earliest.orderId,
      splitOrder: sorted.length > 1,
    }
  })
}

// --------------------------------------------------------
// 4. deduplicateCandidates
// --------------------------------------------------------

/**
 * Filter out candidates already in the journal.
 * Match on underlying + (current) expiration against open journal trades.
 */
export function deduplicateCandidates(
  candidates: ImportCandidate[],
  openJournalTrades: { underlying: string; currentExpiration: string }[],
): { fresh: ImportCandidate[]; alreadyImported: ImportCandidate[] } {
  const existing = new Set(
    openJournalTrades.map((t) => `${t.underlying}__${t.currentExpiration}`),
  )

  const fresh: ImportCandidate[] = []
  const alreadyImported: ImportCandidate[] = []
  for (const c of candidates) {
    if (existing.has(`${c.underlying}__${c.expiration}`)) alreadyImported.push(c)
    else fresh.push(c)
  }
  return { fresh, alreadyImported }
}
