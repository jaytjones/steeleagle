// ============================================================
// SteelEagle — Finnhub Earnings Calendar Client
// Provider for the Tactical Earnings sleeve (v1.4 scoping §1).
//
// The whole sleeve hinges on the `hour` session field (bmo/amc/dmh),
// confirmed populating on the free tier. We pull per-symbol so one bad
// name doesn't poison the batch, and normalize rows into EarningsEvent.
//
// Env: FINNHUB_API_KEY (set in Vercel + .env.local).
// The pure mappers (mapSession, normalizeFinnhubRow) are unit-tested;
// the network call is integration-only (finnhub.io is external).
// ============================================================

import type { EarningsSession } from '@/lib/strategy/earnings-watchlist'

const FINNHUB_BASE = 'https://finnhub.io/api/v1'

/** Normalized provider output — the shape the cache and scanner consume. */
export type EarningsEvent = {
  symbol: string
  /** ISO 'YYYY-MM-DD'. */
  reportDate: string
  session: EarningsSession
  epsEstimate: number | null
  /** False until actuals post (Finnhub has no explicit confirmed-date flag). */
  confirmed: boolean
  /** ISO timestamp of the pull. */
  fetchedAt: string
}

/** Raw Finnhub `/calendar/earnings` row (subset we use). */
interface FinnhubEarningsRow {
  date: string
  epsActual: number | null
  epsEstimate: number | null
  hour: string // 'bmo' | 'amc' | 'dmh' | ''
  quarter?: number
  revenueActual?: number | null
  revenueEstimate?: number | null
  symbol: string
  year?: number
}

interface FinnhubEarningsResponse {
  earningsCalendar: FinnhubEarningsRow[]
}

/** Map Finnhub's `hour` to our session enum. Anything unrecognized → UNKNOWN. */
export function mapSession(hour: string | null | undefined): EarningsSession {
  switch ((hour ?? '').trim().toLowerCase()) {
    case 'bmo':
      return 'BMO'
    case 'amc':
      return 'AMC'
    case 'dmh':
      return 'DMH'
    default:
      return 'UNKNOWN'
  }
}

/** Normalize a raw Finnhub row into an EarningsEvent. Pure. */
export function normalizeFinnhubRow(
  row: FinnhubEarningsRow,
  fetchedAt: string = new Date().toISOString(),
): EarningsEvent {
  return {
    symbol: row.symbol.toUpperCase(),
    reportDate: row.date,
    session: mapSession(row.hour),
    epsEstimate: row.epsEstimate ?? null,
    confirmed: row.epsActual != null,
    fetchedAt,
  }
}

/**
 * Fetch + normalize the earnings calendar for the given symbols over [from, to].
 * Pulls per-symbol (well under the 60/min free-tier limit for a 12-name watchlist).
 * Throws on the first network/parse failure — the cron wraps each symbol so a
 * single failure is isolated rather than aborting the run.
 */
export async function getEarningsCalendar(
  symbols: string[],
  from: string,
  to: string,
): Promise<EarningsEvent[]> {
  const fetchedAt = new Date().toISOString()
  const out: EarningsEvent[] = []

  for (const symbol of symbols) {
    const data = await finnhubGet<FinnhubEarningsResponse>('/calendar/earnings', {
      from,
      to,
      symbol: symbol.toUpperCase(),
    })
    for (const row of data.earningsCalendar ?? []) {
      out.push(normalizeFinnhubRow(row, fetchedAt))
    }
  }

  return out
}

// --------------------------------------------------------
// Network
// --------------------------------------------------------

async function finnhubGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) throw new Error('FINNHUB_API_KEY is not set')

  const url = new URL(`${FINNHUB_BASE}${path}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  url.searchParams.set('token', key)

  const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } })

  // Read once as text so empty / non-JSON bodies give a legible, path-tagged error
  // rather than the cryptic "Unexpected end of JSON input" (the Session 7 lesson,
  // applied to the new provider). The token is never included in the message.
  const body = await response.text()

  if (!response.ok) {
    throw new Error(`Finnhub ${response.status} on ${path}: ${body || '(empty body)'}`)
  }
  if (!body.trim()) {
    throw new Error(`Finnhub ${response.status} on ${path}: empty response body`)
  }
  try {
    return JSON.parse(body) as T
  } catch {
    throw new Error(`Finnhub ${response.status} on ${path}: response was not valid JSON: ${body.slice(0, 200)}`)
  }
}
