// ============================================================
// SteelEagle — Daily Earnings Calendar Snapshot Cron
// GET /api/cron/snapshot-earnings
// Runs each weekday morning via Vercel Cron (the 2nd free-tier job).
//
// Pulls the next ~90 days of earnings for the 12 tradeable watchlist
// names and upserts them into earnings_calendar. Unlike IV there is no
// calibration window — the cache just needs the dates present before the
// scanner reads them. Re-pulling daily catches date drift / confirmation.
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getEarningsCalendar } from '@/lib/earnings/finnhub'
import { upsertEarnings } from '@/lib/db/earnings'
import { tradeableSymbols } from '@/lib/strategy/earnings-watchlist'

// Forward window wide enough to capture the next quarterly report per name.
const FORWARD_WINDOW_DAYS = 90

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const symbols = tradeableSymbols()
  const from = new Date().toISOString().split('T')[0]
  const to = addDaysISO(from, FORWARD_WINDOW_DAYS)

  const results: Record<string, string> = {}
  const failed: string[] = []
  let snapshotted = 0

  // Per-symbol try/catch so one provider hiccup doesn't abort the run (IV-cron pattern).
  for (const symbol of symbols) {
    try {
      const events = await getEarningsCalendar([symbol], from, to)
      const written = await upsertEarnings(events)
      snapshotted += written
      results[symbol] = written > 0 ? `ok — ${written} event(s)` : 'no upcoming earnings in window'
    } catch (err) {
      results[symbol] = `failed: ${err instanceof Error ? err.message : String(err)}`
      failed.push(symbol)
    }
  }

  console.log('Earnings snapshot results:', results)
  return NextResponse.json({ from, to, snapshotted, failed, results })
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().split('T')[0]
}
