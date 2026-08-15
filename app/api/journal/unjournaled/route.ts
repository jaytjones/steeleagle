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
    const items = matches
      .filter((m) => m.actionable)
      .map((m) => {
        const fill = byOrderId.get(m.orderId)
        return {
          orderId: m.orderId,
          verdict: m.verdict,
          detail: m.detail,
          tradeId: m.tradeId,
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
          })),
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
