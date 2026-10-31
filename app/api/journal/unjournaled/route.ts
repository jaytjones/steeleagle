// ============================================================
// SteelEagle — Unjournaled Activity API (v2.11)
// GET /api/journal/unjournaled — recent fills that need journaling or review
//
// READ-ONLY. Nothing in the placement path may call this: reconciliation
// FLAGS, it does not BLOCK (April, 2026-08-04), and the fill ledger is bound
// by the same rule.
//
// Verdicts are computed FRESH on every request rather than stored on the row.
// A stored verdict goes stale the instant the operator journals something —
// the row would keep saying "needs journaling" until the next cron run
// overwrote it, which is exactly the kind of confidently-wrong state this
// codebase refuses. `disposition` stays purely the operator's judgement.
// ============================================================

import { NextResponse } from 'next/server'
import { listFills } from '@/lib/db/fills'
import { listTrades } from '@/lib/db/journal'
import { matchFills, summarizeMatches, ACTIONABLE_WINDOW_DAYS } from '@/lib/journal/match-fill'
import { fillToPrefill, instructionFor } from '@/lib/journal/fill-to-draft'
// v2.16 — split-roll halves pair into ONE Roll form (prefill only, JJ 2026-10-31).
import { pairSplitRoll, splitRollToPrefill } from '@/lib/journal/split-roll'

export async function GET() {
  try {
    // ALL trades, open and closed. A fill belongs to whichever trade recorded
    // it, and omitting closed trades reports every historical fill as
    // unjournaled (see match-fill.ts).
    const [fills, trades] = await Promise.all([listFills({ limit: 200 }), listTrades()])

    const classifications = fills.map((f) => f.classification)
    const matches = matchFills(classifications, trades, new Date())
    const summary = summarizeMatches(matches)

    const byOrderId = new Map(fills.map((f) => [f.orderId, f]))
    const matchById = new Map(matches.map((m) => [m.orderId, m]))
    const items = matches
      .filter((m) => m.actionable)
      .map((m) => {
        const fill = byOrderId.get(m.orderId)
        // v2.16 — a split-roll half with exactly one partner opens ONE Roll form
        // for both. The OPEN half closes nothing, so it has no owner of its own;
        // the trade comes from the CLOSE half's match.
        const pairing = fill ? pairSplitRoll(fill.classification, classifications) : null
        const partner = pairing?.partner ?? null
        return {
          orderId: m.orderId,
          verdict: m.verdict,
          detail: m.detail,
          tradeId: m.tradeId ?? (partner ? matchById.get(partner.orderId)?.tradeId ?? null : null),
          pairedWith: partner?.orderId ?? null,
          underlying: fill?.underlying ?? null,
          expiration: fill?.expiration ?? null,
          occurredAt: fill?.occurredAt ?? null,
          status: fill?.status ?? 'UNKNOWN',
          contracts: fill?.contracts ?? 0,
          netPrice: fill?.classification.netPrice ?? null,
          orderType: fill?.classification.orderType ?? null,
          legs: (fill?.classification.legs ?? []).map((l) => ({
            action: l.action,
            role: l.role,
            strike: l.strike,
            price: l.price,
            // The exact Schwab instruction, derived once here rather than
            // re-derived in the component — the label and the pre-filled
            // credit/debit direction must never disagree about what a leg was.
            instruction: instructionFor(l.action, l.role),
          })),
          // null when there is no form worth opening — an ENTRY is journaled by
          // the sweep (v2.16) or by Import, never through a pre-filled form.
          prefill: !fill
            ? null
            : partner
              ? splitRollToPrefill(fill.classification, partner)
              : fillToPrefill(fill.classification),
        }
      })
      // Newest first — the most recent fill is the one most likely still live.
      .sort((a, b) => (b.occurredAt ?? '').localeCompare(a.occurredAt ?? ''))

    return NextResponse.json({
      items,
      summary,
      ledgerSize: fills.length,
      windowDays: ACTIONABLE_WINDOW_DAYS,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('GET /api/journal/unjournaled error:', message)
    // An error must never render as an empty (i.e. healthy) inbox — the client
    // renders this as an explicit red state.
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
