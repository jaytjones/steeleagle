// ============================================================
// SteelEagle — v2.16 gated auto-journal, ENTRIES (pure — no I/O)
//
// v2.11 §8.2, discharged. Decides WHICH filled four-leg entries the cron may
// journal without JJ. Writes nothing; the route does the I/O.
// Spec: docs/steeleagle-v2-16-spec.md §2. Decisions (JJ, 2026-10-31):
//
//   - Same gate as closes and rolls (auto-journal-gate.ts): a ZERO RESIDUAL
//     for the interval, all or nothing.
//   - The first GTC is HELD until JJ confirms (Q2) — the v2.15 mechanism,
//     unchanged. An automatic journal write reaches placement only by
//     withholding, never by causing one.
//   - Scale-ins ARE journaled as their own trade (Q3) — see DEDUP below.
//
// Runs FIRST in step (d) — entries, rolls, closes, trades re-read between —
// so a same-interval entry-then-close finds the entry's trade. (A same-day
// entry-then-ROLL is refused by the roll pass's H condition while the entry's
// hold is pending; it stays an inbox card. Rare, and conservative.)
//
// ── DEDUP is by ORDER ID, not structure ──
//
// `matchFill` dedups STRUCTURALLY, so a second same-strike entry — the GLD
// 2026-09-18 scale-in, a deliberate, supported workflow (JJ, 2026-08-14) —
// reads ALREADY_JOURNALED and is skipped: Import's key-site (b) blindness,
// reproduced. One order is one entry, and the zero residual proves this order
// moved the position, so:
//
//   a trade's open events carry THIS order id   → skip (already journaled)
//   no trade's open events match these legs     → write (a new entry)
//   matching trades all carry OTHER order ids   → write (a scale-in)
//   a matching trade has NO order id            → REFUSE — a hand-typed copy
//                                                 of THIS entry and a genuine
//                                                 scale-in look identical
//
// Import's `marks_only` path also leaves the order id null, so it lands in
// the last row too. Conservative by construction.
// ============================================================

import type { FillClassification } from './classify-fill'
import { gateDecision, inInterval, type AutoJournalInterval } from './auto-journal-gate'
import { entryInputFromFill } from './entry-from-fill'
import type { NewTradeInput, TradeEvent } from './types'

export interface AutoEntryFill {
  classification: FillClassification
  disposition: string
}

/** The journal side — ALL trades, open and closed. */
export interface AutoEntryTrade {
  id: string
  symbol: string
  events: Pick<TradeEvent, 'eventType' | 'leg' | 'strike' | 'expiration' | 'schwabOrderId'>[]
}

export interface AutoEntryWrite {
  orderId: string
  symbol: string
  expiration: string
  contracts: number
  /** Built ONCE; the route re-maps the live order and refuses on any difference. */
  input: NewTradeInput
}

export interface AutoEntryRefusal {
  orderId: string
  tradeId: string | null
  reason: string
}

export interface AutoEntryPlan {
  gate: 'OPEN' | 'CLOSED'
  gateReason: string
  write: AutoEntryWrite[]
  refused: AutoEntryRefusal[]
  /** Filled four-leg entries inside the interval that were looked at. */
  considered: number
}

/** The note every auto-journaled entry carries — the journal must say JJ did not type it. */
export function autoEntryNote(orderId: string): string {
  return `Journaled automatically from Schwab order ${orderId} — GTC held pending your confirmation.`
}

const entryKey = (leg: string, strike: number, expiration: string) => `${leg}|${strike}|${expiration}`

export function planAutoEntries(input: {
  fills: readonly AutoEntryFill[]
  trades: readonly AutoEntryTrade[]
  interval: AutoJournalInterval | null
  balanceStatus: string | null
}): AutoEntryPlan {
  const decision = gateDecision(input.interval, input.balanceStatus)
  if (decision.gate === 'CLOSED') {
    return { write: [], refused: [], considered: 0, ...decision }
  }
  const interval = decision.interval

  const write: AutoEntryWrite[] = []
  const refused: AutoEntryRefusal[] = []
  let considered = 0

  for (const row of input.fills) {
    if (row.disposition !== 'pending') continue
    const fill = row.classification
    if (
      fill.shape !== 'CONDOR_OPEN' ||
      !fill.filled ||
      fill.status !== 'FILLED' ||
      fill.refusals.length > 0
    ) {
      continue
    }
    if (!inInterval(fill.occurredAt, interval)) continue
    considered++

    const refuse = (tradeId: string | null, reason: string) =>
      refused.push({ orderId: fill.orderId, tradeId, reason })

    try {
      // Already journaled — by Import, recordFillAction, or an earlier run.
      const journaled = input.trades.some((t) =>
        t.events.some((e) => e.eventType === 'open' && e.schwabOrderId === fill.orderId),
      )
      if (journaled) continue

      // Trades whose ENTRY is at exactly these legs.
      const wanted = fill.legs.map((l) => entryKey(l.role, l.strike, l.expiration))
      const holders = input.trades.filter((t) => {
        if (t.symbol !== fill.underlying) return false
        const opens = new Set(
          t.events.filter((e) => e.eventType === 'open').map((e) => entryKey(e.leg, e.strike, e.expiration)),
        )
        return wanted.every((k) => opens.has(k))
      })
      const untagged = holders.find((t) =>
        t.events.some((e) => e.eventType === 'open' && e.schwabOrderId === null),
      )
      if (untagged) {
        refuse(
          untagged.id,
          `trade ${untagged.id.slice(0, 8)} (${untagged.symbol}) was entered at these exact strikes ` +
            `with no Schwab order id on record — it may be a hand-typed copy of THIS entry or a ` +
            `separate scale-in, and nothing says which. Journal it by hand (or Import).`,
        )
        continue
      }

      const entry = entryInputFromFill(fill, autoEntryNote(fill.orderId))
      write.push({
        orderId: fill.orderId,
        symbol: entry.symbol,
        expiration: entry.initialExpiration,
        contracts: entry.contracts,
        input: entry,
      })
    } catch (err) {
      refuse(null, err instanceof Error ? err.message : String(err))
    }
  }

  return { gate: 'OPEN', gateReason: decision.gateReason, write, refused, considered }
}

export function summarizeAutoEntry(plan: AutoEntryPlan): string {
  if (plan.gate === 'CLOSED') return `auto-journal (entries) held: ${plan.gateReason}`
  if (plan.write.length === 0 && plan.refused.length === 0) {
    return `auto-journal (entries) ran with nothing to do — ${plan.considered} filled entry(ies) in the interval`
  }
  const parts = [`${plan.write.length} entry(ies) journaled automatically, GTC held`]
  if (plan.refused.length > 0) parts.push(`${plan.refused.length} refused (left in the inbox)`)
  return parts.join(' · ')
}
