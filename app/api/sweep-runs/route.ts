// ============================================================
// SteelEagle — Sweep Run API (v2.9)
// GET /api/sweep-runs — the latest run, its classification, and freshness
//
// READ-ONLY. This exists so the dashboard can answer "what did the sweep do,
// and did it even run?" — a question the app could not answer at all before
// v2.9, which is how three consecutive correct CRITICAL flags on
// SPY 2026-09-11 (Aug 5–6 2026) reached nobody.
//
// Nothing in the placement path may call this. Reconciliation FLAGS, it does
// not BLOCK (April, 2026-08-04).
// ============================================================

import { NextResponse } from 'next/server'
import { getLatestSweepRun } from '@/lib/db/sweep-runs'
import { summarizeSweepRun, sweepFreshness } from '@/lib/strategy/sweep-report'

export async function GET() {
  try {
    const latest = await getLatestSweepRun()
    const freshness = sweepFreshness(latest ? new Date(latest.ranAt) : null, new Date())

    if (latest === null) {
      // Distinct from a clean run, and rendered that way. An empty table is
      // "the cron has not fired since v2.9 shipped", not "all healthy".
      return NextResponse.json({ latest: null, summary: null, freshness })
    }

    // Re-derived from the stored report rather than read from the stored
    // columns. The columns exist to keep the DB query cheap; the classifier is
    // the truth, so a rule change applies to history instead of leaving old
    // rows frozen under the old rules.
    return NextResponse.json({
      latest: {
        id: latest.id,
        ranAt: latest.ranAt,
        report: latest.report,
      },
      summary: summarizeSweepRun(latest.report),
      freshness,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('GET /api/sweep-runs error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
