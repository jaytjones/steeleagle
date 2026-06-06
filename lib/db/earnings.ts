// ============================================================
// SteelEagle — Earnings Calendar Cache DB Access
// Daily-refreshed cache of upcoming earnings (v1.4 scoping §3).
// Append/upsert on (symbol, report_date), like iv_history.
// ============================================================

import { sql } from '@/lib/db/client'
import type { EarningsEvent } from '@/lib/earnings/finnhub'
import type { EarningsSession } from '@/lib/strategy/earnings-watchlist'

interface EarningsRow {
  symbol: string
  report_date: string // forced to 'YYYY-MM-DD' via to_char on read
  session: string
  eps_estimate: number | null
  confirmed: boolean
  fetched_at: string | Date
}

/**
 * Upserts earnings events on (symbol, report_date). Re-pulling daily keeps the
 * cache current as dates drift or get confirmed (§8.5 warns dates can move).
 * Returns the number of rows written.
 */
export async function upsertEarnings(events: EarningsEvent[]): Promise<number> {
  let written = 0
  for (const ev of events) {
    await sql`
      INSERT INTO earnings_calendar (symbol, report_date, session, eps_estimate, confirmed, fetched_at)
      VALUES (${ev.symbol}, ${ev.reportDate}, ${ev.session}, ${ev.epsEstimate}, ${ev.confirmed}, ${ev.fetchedAt})
      ON CONFLICT (symbol, report_date) DO UPDATE SET
        session      = EXCLUDED.session,
        eps_estimate = EXCLUDED.eps_estimate,
        confirmed    = EXCLUDED.confirmed,
        fetched_at   = EXCLUDED.fetched_at
    `
    written += 1
  }
  return written
}

/**
 * Soonest future (report_date >= asOf) earnings event per symbol. This is the
 * row the scanner reads to compute the entry window. Optionally filtered to a
 * symbol list (the array goes through the positional `sql.query` form —
 * `@vercel/postgres` tagged templates only bind scalars).
 */
export async function getUpcomingEarnings(opts?: {
  symbols?: string[]
  asOfDate?: string
}): Promise<EarningsEvent[]> {
  const asOf = opts?.asOfDate ?? new Date().toISOString().split('T')[0]
  const symbols = opts?.symbols?.map((s) => s.toUpperCase())

  const select = `
    SELECT DISTINCT ON (symbol)
      symbol,
      to_char(report_date, 'YYYY-MM-DD') AS report_date,
      session,
      eps_estimate,
      confirmed,
      fetched_at
    FROM earnings_calendar
  `

  if (symbols && symbols.length > 0) {
    const { rows } = await sql.query<EarningsRow>(
      `${select}
       WHERE report_date >= $1 AND symbol = ANY($2)
       ORDER BY symbol, report_date ASC`,
      [asOf, symbols],
    )
    return rows.map(rowToEvent)
  }

  const { rows } = await sql.query<EarningsRow>(
    `${select}
     WHERE report_date >= $1
     ORDER BY symbol, report_date ASC`,
    [asOf],
  )
  return rows.map(rowToEvent)
}

// --------------------------------------------------------
// Helpers
// --------------------------------------------------------

function rowToEvent(row: EarningsRow): EarningsEvent {
  return {
    symbol: row.symbol,
    reportDate: row.report_date,
    session: normalizeSession(row.session),
    epsEstimate: row.eps_estimate,
    confirmed: row.confirmed,
    fetchedAt: row.fetched_at instanceof Date ? row.fetched_at.toISOString() : String(row.fetched_at),
  }
}

function normalizeSession(value: string): EarningsSession {
  return value === 'BMO' || value === 'AMC' || value === 'DMH' ? value : 'UNKNOWN'
}
